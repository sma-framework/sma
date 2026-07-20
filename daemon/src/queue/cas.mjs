/**
 * cas.mjs — compare-and-set (CAS-UPDATE) state transitions for owned task rows,
 * without locks (Phase 9.5 Plan 03, Task 2; D-9.5-07).
 *
 * ATTRIBUTION (D-9.5-07): the CAS-UPDATE checkout pattern here is ABSORBED AS A
 * CODE PATTERN from **Paperclip** (github.com/paperclipai/paperclip, HEAD `3a727bf7`,
 * MIT, © 2025 Paperclip AI) — «UPDATE … SET status='x' WHERE id=? AND
 * status='expected' RETURNING; zero rows = you lost the race, no locks». The
 * claim-generation hardening (ALSO require `dispatched_at` in the WHERE, so a stale
 * handler cannot roll back a NEWER reclaim) is a **Multica IDEA, our own
 * implementation** — no Multica code is copied. Full record: `THIRD-PARTY-LICENSES.md`.
 *
 * WHY CAS, NOT LOCKS (Pitfall 4): advisory locks / SELECT FOR UPDATE queues LEAK on a
 * crash — a killed handler holding a lock wedges the row until a human intervenes. A
 * CAS UPDATE is self-clearing: it either wins atomically (1 row) or reports a lost
 * race (0 rows), and a crash mid-flight leaves the row exactly as it was. The daemon
 * must be killable at ANY line with zero lost state (D-9.5-02).
 *
 * SAFETY: `table` and `extra`/`from`/`to` COLUMN NAMES are TRUSTED IDENTIFIERS chosen
 * by the daemon (e.g. 'sma_task_attempts', 'status') — NEVER user input. All VALUES
 * (id, from, to, dispatchedAt, extra values) are bound as `$n` parameters. Never pass
 * caller/founder free-text as a table or column name.
 *
 * DI: the SQL executor is injected — `execSql(sql, params) -> {rows}` — the SAME seam
 * the pg-boss backend uses for its read-only list(). Tests feed a recorder; no live
 * Postgres is ever required.
 */

/**
 * casTransition(execSql, opts) — issue ONE compare-and-set UPDATE. Wins iff exactly
 * one row matched the expected state (and claim generation, when given). Never throws
 * on a LOST race — a 0-row result is a normal `{won:false}`, not an error. Throws only
 * on programmer errors (missing execSql / table / id / from / to).
 *
 * @param {(sql:string, params:any[]) => Promise<{rows:any[]}>} execSql
 * @param {{table:string, id:*, from:string, to:string, dispatchedAt?:*, extra?:object}} opts
 * @returns {Promise<{won:boolean, rows:any[]}>}
 */
export async function casTransition(execSql, opts = {}) {
  const { table, id, from, to, dispatchedAt, extra } = opts
  if (typeof execSql !== 'function') throw new TypeError('casTransition requires an execSql function')
  if (!table || typeof table !== 'string') throw new TypeError('casTransition requires a table name')
  if (id === undefined || id === null) throw new TypeError('casTransition requires an id')
  if (!from || !to) throw new TypeError('casTransition requires both from and to states')

  const params = []
  const setCols = []

  // SET status = $n
  params.push(to)
  setCols.push(`status = $${params.length}`)

  // additional SET columns (trusted identifiers, bound values)
  const extraEntries = extra && typeof extra === 'object' ? Object.entries(extra) : []
  for (const [col, val] of extraEntries) {
    params.push(val)
    setCols.push(`${col} = $${params.length}`)
  }

  // WHERE id = $n AND status = $n [AND dispatched_at = $n]
  params.push(id)
  const pId = params.length
  params.push(from)
  const pFrom = params.length
  let where = `id = $${pId} AND status = $${pFrom}`
  if (dispatchedAt !== undefined && dispatchedAt !== null) {
    params.push(dispatchedAt)
    where += ` AND dispatched_at = $${params.length}` // claim generation (Multica idea)
  }

  const sql = `UPDATE ${table} SET ${setCols.join(', ')} WHERE ${where} RETURNING id`
  const res = await execSql(sql, params)
  const rows = res && Array.isArray(res.rows) ? res.rows : []
  return { won: rows.length === 1, rows }
}
