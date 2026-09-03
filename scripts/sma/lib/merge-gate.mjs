/**
 * merge-gate.mjs — the serialized merge gate + the verified-live-only
 * enforcing-scope predicate.
 *
 * ═══════════════════════════ THE MERGE RITUAL ═══════════════════════════════════
 *
 * A worktree branch enters `main` ONLY through `runMerge`, under a
 * merge-claim slot, IN ORDER:
 *   1. acquire the `merge-in-progress` slot   (a concurrent merge -> SOFT-deny + override)
 *   2. bring the branch into the WORKING TREE WITHOUT COMMITTING IT
 *                                             (`merge --no-ff --no-commit`; mock/real execGit —
 *                                              NEVER a push, NEVER a deploy)
 *   2a. A CONFLICT IS NAMED, AND THE MECHANICAL HALF OF IT IS SETTLED WITHOUT A PERSON
 *                                             (branch-sync.mjs: `conflictedFiles` asks git
 *                                              WHICH files, `resolveMechanical` rebuilds what
 *                                              is generated and keeps BOTH appended paragraphs
 *                                              where both sides only appended). Anything left
 *                                              travels out by NAME and by COUNT — never again
 *                                              as one line of «Command failed».
 *   3. ask whether there was anything to bring at all (`rev-parse -q --verify MERGE_HEAD`).
 *      Nothing to bring is SAID, never dressed up as a run that happened.
 *   4. run the injected tests ON THE MERGED WORKING TREE. There is no result sha at this
 *      step BY DESIGN — no merge commit exists yet — so the runner is handed the TREE and
 *      an explicit null, never yesterday's sha quietly passed along.
 *   5. DECIDE, and only now touch history:
 *        red run   -> `git merge --abort`, a REFUSAL receipt, {merged:false}. The branch tip
 *                     never moved: there is nothing to revert, because nothing happened.
 *        green run, or no run at all
 *                  -> `git commit --no-edit`, and THAT is when the merge commit — and its
 *                     sha — comes into existence.
 *   6. journal the receipt (merged OR refused — honestly) and release the slot.
 *
 * THE ORDER IS THE WHOLE POINT. It used to be the other way round: the merge was committed
 * first and the tests were run on it afterwards, and there was no undo branch anywhere in
 * this file. A gate whose worst outcome is «merged anyway, and the tests were red» is not a
 * gate, it is a report written after the fact.
 *
 * TWO PRICES OF THAT ORDER, said out loud because neither of them is free:
 *   - THE HALF-MERGED WINDOW IS NOW LONG. On the command-line path the ritual runs in the
 *     SHARED checkout root, and between step 2 and step 5 there now lies an entire test run.
 *     For all of that time the shared tree stands with an UNCOMMITTED merge inside it while
 *     neighbouring terminals work in that same tree. Narrowing the run down to a small target
 *     is separate work; the cost is named here rather than left for whoever meets it.
 *   - AN UNDO THAT ITSELF FAILED MUST SAY SO. When `merge --abort` throws, the answer states
 *     that the tree was LEFT in an unfinished merge and gives the command out of it. Silence
 *     here is exactly the case of «it can be rolled back, but nobody can see to what».
 *
 * This kills «your push carried my half-built work»: integration is serialized, tested
 * on the merged tree BEFORE it is recorded, receipted, and LOCAL. `git push` is explicitly
 * OUT of scope — push stays founder-ordered via /sma-ship (slots.mjs header law, unchanged).
 *
 * ═══════════════════════════ CONSUME-NEVER-REIMPLEMENT ══════════════════════════
 *
 * The merge-claim triplet (acquire/release/check) mirrors slots.mjs's push-claim triplet
 * near line-for-line, built on claims.mjs's claimSlot/releaseSlot mkdir-EEXIST primitive
 * (`claimSlot('merge-in-progress', …)`, NO new directory, NO bespoke lockfile). The
 * enforcing check reuses verifyClaimEvidence (collision.mjs) for the
 * verified-LIVE-vs-stale decision — ONE evidence source, never a second logic.
 *
 * ═══════════════════════════ POSTURE LOCKS (carried) ════════════════════════════
 *
 *   - The C9 fail-open wrapper is absolute: any error in runMerge or enforceScope
 *     degrades to an honest failure / allow, releasing any held slot — a gate bug can
 *     NEVER wedge a session and NEVER leave a slot stuck.
 *   - enforceScope is SOFT-deny-with-override ONLY (mayDeny tier). Hard deny remains the
 *     security guard's alone. The founder word always wins: releaseSlot's
 *     foreign-claim refusal + force-clear provenance are inherited unchanged, and a
 *     cooling-down / force-cleared scope is NEVER enforced.
 *
 * Node built-ins only; everything DI (execGit + runTests + claimsDir + journalDir +
 * verifyClaimEvidence injected) so tests never run a real merge, never touch the real
 * `.sma/`, never spend a token. Zero npm deps.
 */

import { execFileSync } from 'node:child_process'

import { claimSlot, releaseSlot, readClaims } from './claims.mjs'
import { appendEvent } from './journal.mjs'
import { MERGE_CLAIM_TTL_MS, MERGE_SLOT_NAME } from './constants.mjs'
import { conflictedFiles, conflictWords, resolveMechanical, MECHANICAL_DEFAULTS } from './branch-sync.mjs'
import { checkEnvironmentFitness } from './deps-guard.mjs'

// Re-export the slot name so consumers import the merge contract from one place.
export { MERGE_SLOT_NAME } from './constants.mjs'

/**
 * The override instruction a SOFT-deny carries — the legitimate escape hatch so an
 * enforcing soft-deny can NEVER block real work. Plain RU (shareholder-facing).
 */
export const ENFORCE_OVERRIDE_HINT =
  'переопределить (если правка действительно нужна): SMA_ENFORCE_SCOPES_DISABLE=1 для этого вызова, ' +
  'либо согласуйте со владельцем скоупа; если claim завис — node scripts/sma/cli.mjs force-clear <scope>'

/** Default real git runner: execFileSync with an args ARRAY (no shell interpolation). */
export function defaultExecGit(args, opts = {}) {
  return execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8' })
}

/**
 * journalOpt(o) — the appendEvent dir opt for merge-slot events. Prefer an explicit
 * journalDir; fall back to claimsDir for callers that only pass that (legacy parity with
 * slots.mjs); default to {} (the constants-derived JOURNAL_DIR) when neither is supplied.
 */
function journalOpt(o) {
  if (o && o.journalDir) return { journalDir: o.journalDir }
  if (o && o.claimsDir) return { journalDir: o.claimsDir }
  return {}
}

/** Truthy env-flag test (matches the reflex/gates kill-switch convention). */
function envOn(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return !!s && s !== '0' && s !== 'false'
}

// ── the merge-claim triplet — mirrors slots.mjs's push-claim triplet ────────────────

/**
 * acquireMergeClaim({by, session, branch, claimsDir}) — win the single
 * `merge-in-progress` advisory slot via claimSlot (mkdir-EEXIST). This serializes
 * integration: a second concurrent acquire returns {acquired:false, holder} (never a
 * throw). The branch rides in `reason` as a suffix so checkMergeClaim can read it back
 * without changing the claim's provenance stamp. Returns {acquired, holder?}.
 */
export function acquireMergeClaim(o = {}) {
  const claimOpts = o.claimsDir ? { claimsDir: o.claimsDir } : {}
  const terminalId = o.by ?? 'unknown'
  const branch = o.branch ?? null
  const res = claimSlot(
    MERGE_SLOT_NAME,
    {
      by: o.by,
      session: o.session ?? null,
      expectedPrev: null,
      reason: branch ? `merge-in-progress:${branch}` : 'merge-in-progress',
    },
    claimOpts,
  )
  if (res.won) {
    appendEvent(
      { type: 'claim', scope: MERGE_SLOT_NAME, detail: { branch } },
      { terminalId, ...journalOpt(o) },
    )
    return { acquired: true }
  }
  return { acquired: false, holder: res.holder ?? null }
}

/**
 * releaseMergeClaim({by, claimsDir}) — release the caller's OWN merge claim. A foreign
 * claim is refused by releaseSlot (P3) — force-clear lives in the interactive
 * CLI, never here.
 */
export function releaseMergeClaim(o = {}) {
  const claimOpts = o.claimsDir ? { claimsDir: o.claimsDir } : {}
  const terminalId = o.by ?? 'unknown'
  const res = releaseSlot(MERGE_SLOT_NAME, { by: o.by, ...claimOpts })
  if (res.released) {
    appendEvent(
      { type: 'release', scope: MERGE_SLOT_NAME },
      { terminalId, ...journalOpt(o) },
    )
  }
  return res
}

/**
 * checkMergeClaim({claimsDir, now}) — inspect the merge slot WITHOUT mutating it.
 *   - live claim within TTL -> {live:true, who, since, branch, warn, howToClear}
 *   - claim older than TTL  -> {live:false, stale:true, needsHuman:true, who, since, branch}
 *   - no claim              -> {live:false}
 * A foreign live claim is NEVER removed here; a stale one is flagged for a human, never
 * auto-deleted (P3). Mirrors slots.mjs checkPushClaim.
 */
export function checkMergeClaim(o = {}) {
  const claimOpts = o.claimsDir ? { claimsDir: o.claimsDir } : {}
  const claims = readClaims(claimOpts)
  const entry = claims.find((c) => c.name === MERGE_SLOT_NAME)
  if (!entry) return { live: false }

  const prov = entry.provenance
  const who = prov && prov.by ? prov.by : 'неизвестный терминал'
  const since = prov && prov.at ? prov.at : null
  const reason = (prov && prov.reason) || ''
  const branchMatch = /merge-in-progress:(.+)$/.exec(reason)
  const branch = branchMatch ? branchMatch[1] : null

  const now = o.now ?? Date.now()
  const startedMs = since ? Date.parse(since) : NaN
  const ageMs = Number.isFinite(startedMs) ? now - startedMs : entry.ageMs

  if (ageMs > MERGE_CLAIM_TTL_MS) {
    // Stale — flag for a human; DO NOT auto-delete a foreign claim (P3).
    return { live: false, stale: true, needsHuman: true, who, since, branch }
  }

  return {
    live: true,
    who,
    since,
    branch,
    warn: `слияние уже идёт: ${who}${since ? ` (с ${since})` : ''} — дождитесь завершения`,
    howToClear: 'дождитесь / node scripts/sma/cli.mjs force-clear merge-in-progress',
  }
}

// ── the `sma merge` ritual — claim -> merge-uncommitted -> tests -> DECIDE -> receipt ──

/**
 * NO_RUNNER_NOTE / RUNNER_SAID_NOTHING_RAN — the two reasons a run can be absent, in words.
 *
 * `testsPassed: null` used to be nameless, and two very different worlds arrived at the
 * reader wearing the same face: a build where nobody wired a test runner at all, and a build
 * where the runner IS wired, did answer, and its answer was «there was nothing here to run».
 * The first is a hole in the assembly; the second is a fact about the tree. Telling them
 * apart is the whole reason this field exists, and it travels BOTH in the return value and
 * in the journalled receipt — a distinction that only lives in memory is not a distinction.
 */
export const NO_RUNNER_NOTE = 'прогонятель тестов не подключён — прогона не было'
export const RUNNER_SAID_NOTHING_RAN = 'прогонятель ответил, что запускать было нечего'

/**
 * ТРЕТЬЯ ПРИЧИНА, ПО КОТОРОЙ ПРОГОНА НЕ БЫЛО, И ОНА НЕ ПОХОЖА НА ДВЕ ПЕРВЫЕ: дерево не
 * годится, чтобы в нём вообще что-то запускать.
 *
 * 31.08.2026 склад зависимостей основного дерева опустошался трижды, и каждый раз гейт
 * слияния сообщал ровно одно: «тесты на сведённом рабочем дереве красные». Это неправда,
 * и неправда дорогая: задачу возвращают работнику, работник ищет регрессию, которой нет,
 * а сломана среда — одна на всех и чинится в другом месте другой рукой. Поэтому перед
 * прогоном задаётся отдельный вопрос, и его ответ едет отдельным полем: `envBroken`.
 * `testsPassed` при этом остаётся null — прогона НЕ БЫЛО, и утверждать о нём нечего.
 */
export const ENV_UNFIT_NOTE = 'среда прогона непригодна — прогон не запускался'

/**
 * ОТКАЗ, КОТОРЫЙ НЕ НАЗЫВАЕТ УПАВШЕГО ТЕСТА, ПЕРЕКЛАДЫВАЕТ РАССЛЕДОВАНИЕ НА ЧИТАТЕЛЯ.
 *
 * 31.08.2026 приёмка вернула ровно одну фразу — «тесты на сведённом рабочем дереве красные» —
 * и ни слова о том, какой тест и почему. Приёмщик пошёл искать руками и нашёл не регрессию, а
 * пустой склад зависимостей: час чужого времени и возвращённая работнику здоровая работа.
 *
 * Имя берётся у прогонятеля и НИКОГДА не выдумывается: прогонятель, который смолчал, назван
 * смолчавшим. Правдоподобное имя хуже отсутствующего — по нему чинят не тот тест, а настоящая
 * причина остаётся на месте.
 */
/**
 * ЧЕТВЁРТАЯ ПРИЧИНА ОТКАЗА, И ОНА НЕ ПРО ТЕСТЫ ВОВСЕ: ОКНО НЕ СОБРАЛОСЬ.
 *
 * Прогонятель посадки пересобирает окно на сведённом дереве прежде, чем судить его тестами
 * (иначе гейт свежести раздачи краснеет на КАЖДОЙ ветке, которая тронула исходник окна). Если
 * сборка не прошла — прогона не было вовсе, и назвать это «тесты красные» значило бы послать
 * человека искать упавший тест, пока чинить надо сборку. Своё имя, свой код и хвост вывода
 * сборки: причина живёт в последних строках, и отказ без них — «сломалось» без единого слова
 * о том, где.
 */
export const SPA_BUILD_FAILED_CODE = 'spa_build_failed'
export const SPA_BUILD_FAILED_NOTE = 'сборка окна не прошла — прогона не было'
export function spaBuildReason(tail) {
  const said = typeof tail === 'string' && tail.trim() ? tail.trim() : null
  return (
    'окно не собралось на сведённом дереве — слияние не зафиксировано; ' +
    (said ? `хвост сборки: ${said}` : 'сборщик не сказал ни строки — смотрите вывод сборки')
  )
}

export const RED_RUN_NAME_MISSING = 'имя упавшего теста прогонятель не назвал — смотрите вывод прогона'

/**
 * …А ВЫВОД ПРОГОНА НАДО ГДЕ-ТО СМОТРЕТЬ, И ЭТО ТОЖЕ НАЗЫВАЕТСЯ ЗДЕСЬ.
 *
 * 02.09.2026, первая ночная приёмка: отказ отослал к выводу прогона, а самого вывода не было
 * нигде — отчёт полного набора писался во временный каталог и умирал вместе с отказом.
 * Приёмщик не мог отличить настоящий красный от ложного, который полный прогон даёт под
 * нагрузкой. Прогонятель теперь кладёт отчёт в дом данных демона и называет путь; ритуал его
 * ДОНОСИТ — как и имя теста, ничего не выясняя сам.
 */
export function redRunReason(failedTest, savedReport) {
  const named = typeof failedTest === 'string' && failedTest.trim() ? failedTest.trim() : null
  const kept = typeof savedReport === 'string' && savedReport.trim() ? savedReport.trim() : null
  return (
    `тесты на сведённом рабочем дереве красные — слияние не зафиксировано; упал: ${named ?? RED_RUN_NAME_MISSING}` +
    (kept ? `; отчёт прогона: ${kept}` : '')
  )
}

/** The tree is left mid-merge only when the undo itself failed — and then it is NAMED. */
function unfinishedMergeHint(cwd) {
  return `рабочее дерево осталось в НЕЗАВЕРШЁННОМ слиянии — выйти из него: git -C ${cwd} merge --abort`
}

/**
 * runMerge({branch, execGit, runTests, claimsDir, journalDir, cwd, by, now}) — the
 * serialized merge ritual, ASYNC. IN ORDER: acquire the merge slot (a concurrent hold ->
 * SOFT-deny + override) -> bring the branch into the working tree WITHOUT committing ->
 * run the injected tests on that merged tree -> DECIDE (red -> `merge --abort` + a refusal
 * receipt; green or no-run -> `commit --no-edit`) -> journal a receipt -> release the slot.
 * Wrapped fail-open (C9): any error aborts the uncommitted merge, releases the held slot and
 * returns an honest failure — NEVER a throw, NEVER a wedged slot, NEVER a false green.
 *
 * WHY THIS FUNCTION IS ASYNC AND WHY THE RUNNER IS AWAITED. The runner used to be called
 * with no await at all. Any asynchronous runner would then hand back a promise, and
 * `!!(promise && promise.passed)` is `false` — so EVERY merge would have been refused, by a
 * gate that looked like it was working. A mine that goes off silently and reads as a feature.
 * The await is here whether or not today's runner happens to be synchronous, and there is a
 * test that goes red the moment it is removed.
 *
 * `testsPassed` is `true`/`false` ONLY when a runner was injected and actually ran; it is
 * `null` when no run happened, because «тесты не запускались» is a different fact from «тесты
 * прошли» and a receipt may state only what took place. Readers deciding an outcome must treat
 * null as «нечего утверждать» — a red run (false) blocks, an absent one does not. When it is
 * null, `testsNote` says in words WHICH of the two absences it was (see the pair above).
 *
 * @returns
 *   - concurrent hold: {merged:false, softDenied:true, override, holder}
 *   - nothing to merge: {merged:true, alreadyUpToDate:true, testsPassed:null, testsNote, branch, resultSha:null, receipt}
 *   - env broken:      {merged:false, refused:true, envBroken:true, testsPassed:null, testsNote, reason, branch, receipt}
 *   - window unbuilt:  {merged:false, refused:true, spaBuildFailed:true, reasonCode, testsPassed:null, testsNote, reason, branch, receipt[, failureDetail, spaBuild]}
 *   - refused (red):   {merged:false, testsPassed:false, refused:true, branch, receipt[, failedTest, failureDetail][, unfinishedMerge, howToClear]}
 *   - merged:          {merged:true, testsPassed:boolean|null, testsNote?, branch, resultSha, receipt}
 *   - error:           {ok:false, message[, unfinishedMerge, howToClear]}
 */
export async function runMerge(o = {}) {
  const branch = o.branch
  const execGit = o.execGit ?? defaultExecGit
  const runTests = o.runTests
  const claimOpts = o.claimsDir ? { claimsDir: o.claimsDir } : {}
  const journalDir = o.journalDir
  const terminalId = o.by ?? 'unknown'
  const cwd = o.cwd ?? process.cwd()

  let claimed = false
  // TRUE from the moment the branch is in the working tree until it is either committed or
  // aborted. It is what the catch block below reads to know whether there is a half-merge to
  // undo — «откатываемо» is not the same thing as «видно, к чему откатывать».
  let mergeInTree = false
  /**
   * ЧТО ИМЕННО НЕ СОШЛОСЬ — заполняется при конфликте и читается общим catch ниже.
   *
   * До этого поля конфликт доезжал до человека как «слияние не прошло: Command failed»: имя
   * файла в этой строке отсутствовало, и приёмщик КАЖДЫЙ РАЗ выяснял состав конфликта сам,
   * руками, в чужой копии. Замерено 31.08.2026 на пяти приёмках подряд.
   */
  let conflictDetail = null
  /** Что развелось механически по дороге — едет в квитанцию, а не остаётся молчаливым. */
  let mechanicallyResolved = []
  /**
   * …И С КАКОЙ ОГОВОРКОЙ. Развод, прошедший вопреки отказу команды пересборки («аудитор вернул
   * ненулевой код, но обе стороны пересобрались в одно»), и развод, прошедший гладко, — разные
   * события. Квитанция, называющая их одинаково, врёт ровно тому читателю, ради которого она
   * пишется; на пути отказа эти строки едут как `conflictNotes` — здесь у них та же цена.
   */
  let mechanicalNotes = []
  try {
    if (!branch || typeof branch !== 'string') return { ok: false, message: 'no-branch' }

    // (1) acquire the merge slot — a concurrent hold is a SOFT-deny with an override path.
    const acq = acquireMergeClaim({ by: o.by, session: o.session, branch, journalDir, ...claimOpts })
    if (!acq.acquired) {
      const holder = acq.holder && acq.holder.by ? acq.holder.by : 'другой терминал'
      return {
        merged: false,
        softDenied: true,
        override: `слияние уже идёт (${holder}) — дождитесь завершения, либо, если оно зависло: node scripts/sma/cli.mjs force-clear ${MERGE_SLOT_NAME}`,
        holder: acq.holder ?? null,
      }
    }
    claimed = true

    // (2) bring the branch into the WORKING TREE, WITHOUT committing it. NO push, NO deploy
    //     (slots.mjs header law). Nothing has entered history yet — that is the point.
    //     The flag goes up BEFORE the call, not after: a conflicting merge exits non-zero and
    //     STILL leaves the tree half-merged, so a flag set on the success path would leave
    //     exactly the conflict case — the likeliest one of all — without an undo.
    mergeInTree = true
    try {
      execGit(['merge', '--no-ff', '--no-commit', branch], { cwd })
    } catch (err) {
      // (2a) КОНФЛИКТ НАЗЫВАЕТСЯ ПО ИМЕНАМ, И МЕХАНИЧЕСКОЕ РАЗВОДИТСЯ БЕЗ ЧЕЛОВЕКА.
      //
      // Раньше отсюда был ровно один путь — наружу, в общий catch, и человек получал первую
      // строку ошибки git. Теперь сначала задаётся вопрос самому git («что осталось в
      // конфликте»), потом разводится то, что разводится БЕЗ ВЫБОРА: сгенерированное
      // пересобирается своей командой, абзац, дописанный обеими сторонами, остаётся обоими
      // абзацами. Если после этого не осталось НИЧЕГО — ритуал идёт дальше как ни в чём не
      // бывало, и прогон тестов ниже проверяет именно разведённое дерево. Если осталось хоть
      // что-то — падаем наружу, но уже с именами файлов и их числом.
      const found = conflictedFiles({ cwd, execGit })
      if (!found.answered || found.count === 0) throw err
      // ЗДЕСЬ ВЕРШИНА — ЭТО `ours`: ветка въезжает В main, и «своя» сторона и есть вершина.
      // Названо явно, а не оставлено умолчанию: у другой двери (сведение ветки) направление
      // обратное, и молчаливое совпадение с умолчанием — это не договор, а совпадение.
      const fixed = resolveMechanical({ cwd, execGit, files: found.files, rules: o.mechanicalRules ?? MECHANICAL_DEFAULTS, io: o.io, run: o.run, trunkSide: 'ours' })
      if (fixed.remaining.length > 0) {
        conflictDetail = {
          conflict: true,
          conflictFiles: fixed.remaining,
          conflictCount: fixed.remaining.length,
          ...(fixed.resolved.length ? { conflictResolved: fixed.resolved } : {}),
          ...(fixed.notes.length ? { conflictNotes: fixed.notes } : {}),
          words: conflictWords({ files: fixed.remaining, count: fixed.remaining.length }),
        }
        throw err
      }
      mechanicallyResolved = fixed.resolved
      mechanicalNotes = fixed.notes
    }

    // (3) was there anything to bring? An `--no-commit` merge of a branch that is already in
    //     the tree leaves NO MERGE_HEAD and nothing staged. That is not a run and not a
    //     refusal — it is «сводить было нечего», and it gets said in those words rather than
    //     acted out as a merge that happened.
    let mergeHead = ''
    try {
      mergeHead = String(execGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd })).trim()
    } catch {
      mergeHead = ''
    }
    if (!mergeHead) {
      mergeInTree = false
      const receipt = {
        branch,
        resultSha: null,
        repo: cwd,
        testsPassed: null,
        testsNote: 'ветка уже в дереве — сводить было нечего, прогон не запускался',
        alreadyUpToDate: true,
      }
      try {
        appendEvent({ type: 'merge', scope: MERGE_SLOT_NAME, detail: receipt }, { terminalId, ...journalOpt(o) })
      } catch {
        /* fail-open — a journal failure never blocks the ritual */
      }
      releaseMergeClaim({ by: o.by, journalDir, ...claimOpts })
      claimed = false
      return {
        merged: true,
        alreadyUpToDate: true,
        testsPassed: null,
        testsNote: receipt.testsNote,
        branch,
        resultSha: null,
        receipt,
      }
    }

    // (4) run the tests ON THE MERGED WORKING TREE.
    //
    // `resultSha` IS NULL HERE ON PURPOSE, AND THAT IS PART OF THE CONTRACT. The merge commit
    // does not exist yet; passing the previous HEAD instead would hand the runner a sha that
    // names the tree BEFORE the branch arrived, which is the one thing the run must not be
    // about. The runner gets the directory and an explicit null, and a runner that needs a sha
    // is a runner that must be told there is none.
    //
    // NULL UNTIL SOMETHING ACTUALLY RUNS. This started as `true` and stayed `true` whenever no
    // runner was injected, so a receipt asserted that tests had passed on a merge where not one
    // test was executed — the one claim a receipt exists to prevent. Three answers, not two:
    // true and false state an OUTCOME, null states that there was no run to have an outcome.
    let testsPassed = null
    let testsNote = NO_RUNNER_NOTE
    // ЧТО ИМЕННО УПАЛО — если прогонятель это сказал. Ритуал ничего не выясняет сам и ничего
    // не додумывает: он ДОНОСИТ. Прогонятель, промолчавший об имени, оставляет здесь null, и
    // отказ ниже скажет об этом словами вместо правдоподобной выдумки.
    let failedTest = null
    let failureDetail = null
    // ИМЕНА ВСЕХ УПАВШИХ И ГДЕ ЛЕЖИТ ОТЧЁТ — та же роль доносчика: ритуал не открывает
    // отчёта и не считает падений, он передаёт то, что сказал прогонятель.
    let failedTests = []
    let savedReport = null
    let savedLog = null

    // (4a) ПЕРЕД ПРОГОНОМ — ГОДИТСЯ ЛИ СРЕДА. Спрашивается ТОЛЬКО когда прогонятель есть:
    // сборке без прогонятеля нечего защищать, и отказ там остановил бы работу ни за что.
    // Ответ читается как ДАННЫЕ и по единственному правилу: непригодная среда — это отказ
    // СО СВОИМ ИМЕНЕМ, потому что чинит её другой человек в другом дереве, а «красные
    // тесты» отправили бы работника искать регрессию, которой нет. Собственная поломка
    // проверки читается как «годится» (fail-open) — страж, останавливающий все слияния
    // из-за своей ошибки, хуже отсутствующего.
    const envCheck = typeof o.checkEnv === 'function' ? o.checkEnv : checkEnvironmentFitness
    let fitness = { fit: true, reason: null, broken: [] }
    if (runTests) {
      try {
        fitness = envCheck({ root: cwd }) || fitness
      } catch {
        fitness = { fit: true, reason: null, broken: [] }
      }
    }
    if (runTests && fitness.fit === false) {
      let unfinished = false
      try {
        execGit(['merge', '--abort'], { cwd })
        mergeInTree = false
      } catch {
        unfinished = true
      }
      const receipt = {
        branch,
        resultSha: null,
        repo: cwd,
        testsPassed: null,
        testsNote: ENV_UNFIT_NOTE,
        refused: true,
        envBroken: true,
        reason: fitness.reason,
        brokenDeps: Array.isArray(fitness.broken) ? fitness.broken : [],
        ...(unfinished ? { unfinishedMerge: true, howToClear: unfinishedMergeHint(cwd) } : {}),
      }
      try {
        appendEvent({ type: 'merge', scope: MERGE_SLOT_NAME, detail: receipt }, { terminalId, ...journalOpt(o) })
      } catch {
        /* fail-open — a journal failure never blocks the ritual */
      }
      releaseMergeClaim({ by: o.by, journalDir, ...claimOpts })
      claimed = false
      return {
        merged: false,
        refused: true,
        envBroken: true,
        testsPassed: null,
        testsNote: ENV_UNFIT_NOTE,
        reason: fitness.reason,
        branch,
        receipt,
        ...(unfinished ? { unfinishedMerge: true, howToClear: unfinishedMergeHint(cwd) } : {}),
      }
    }

    // ЧТО ИМЕННО ПОЛУЧИЛОСЬ, СКАЗАННОЕ ХЕШЕМ, А НЕ ИМЕНАМИ ВЕТОК. Индекс незафиксированного
    // слияния — это уже то дерево, которое станет деревом коммита, и `write-tree` называет его
    // раньше, чем коммит появится. Прогонятель, умеющий спросить «а не измерено ли это дерево
    // уже», получает здесь единственный ответ, по которому такой вопрос вообще можно задать;
    // тот, кому это безразлично, просто не читает лишнее поле. Молчание git — это `null`,
    // то есть «неизвестно», и ни один читатель не имеет права прочесть его как «совпало».
    let mergedTree = null
    try {
      const written = String(execGit(['write-tree'], { cwd })).trim()
      mergedTree = /^[0-9a-f]{7,40}$/.test(written) ? written : null
    } catch {
      mergedTree = null
    }

    // ПЕРЕСОБРАННОЕ ОКНО — ФАКТ О СЛИЯНИИ, А НЕ О ПРОГОНЕ, и потому едет в квитанцию
    // отдельным полем: «дверь пересобрала раздачу и это заняло столько-то» нельзя вывести ни
    // из зелёного прогона, ни из его отсутствия.
    let spaBuild = null

    if (runTests) {
      const tr = await runTests({ branch, resultSha: null, cwd, mergedTree })
      if (tr && typeof tr.spaBuild === 'object' && tr.spaBuild) spaBuild = tr.spaBuild

      // (4b) ОКНО НЕ СОБРАЛОСЬ — ОТКАЗ СО СВОИМ ИМЕНЕМ. Стоит ВЫШЕ разбора приговора: у этого
      //      ответа приговора нет вовсе (прогон не начинался), а `passed:false` при
      //      `ran:false` прочли бы ниже как «запускать было нечего» и СЛИЛИ бы ветку.
      if (tr && tr.spaBuildFailed === true) {
        const tail = typeof tr.failureDetail === 'string' && tr.failureDetail.trim() ? tr.failureDetail.trim() : null
        let unfinished = false
        try {
          execGit(['merge', '--abort'], { cwd })
          mergeInTree = false
        } catch {
          unfinished = true
        }
        const receipt = {
          branch,
          resultSha: null,
          repo: cwd,
          testsPassed: null,
          testsNote: SPA_BUILD_FAILED_NOTE,
          refused: true,
          spaBuildFailed: true,
          reasonCode: SPA_BUILD_FAILED_CODE,
          reason: spaBuildReason(tail),
          ...(tail ? { failureDetail: tail } : {}),
          ...(spaBuild ? { spaBuild } : {}),
          ...(unfinished ? { unfinishedMerge: true, howToClear: unfinishedMergeHint(cwd) } : {}),
        }
        try {
          appendEvent({ type: 'merge', scope: MERGE_SLOT_NAME, detail: receipt }, { terminalId, ...journalOpt(o) })
        } catch {
          /* fail-open — a journal failure never blocks the ritual */
        }
        releaseMergeClaim({ by: o.by, journalDir, ...claimOpts })
        claimed = false
        return {
          merged: false,
          refused: true,
          spaBuildFailed: true,
          reasonCode: SPA_BUILD_FAILED_CODE,
          testsPassed: null,
          testsNote: SPA_BUILD_FAILED_NOTE,
          reason: receipt.reason,
          ...(tail ? { failureDetail: tail } : {}),
          ...(spaBuild ? { spaBuild } : {}),
          branch,
          receipt,
          ...(unfinished ? { unfinishedMerge: true, howToClear: unfinishedMergeHint(cwd) } : {}),
        }
      }

      // A runner may say «I ran nothing» in its own voice: passed:null, or an explicit flag.
      // Anything else is an OUTCOME and is read as one — a runner that answers nonsense is
      // still a red answer, never a quiet null that would let the merge through.
      const saidNothingRan = !!tr && (tr.passed === null || tr.ran === false || tr.nothingToRun === true)
      if (saidNothingRan) {
        testsPassed = null
        testsNote = typeof tr.note === 'string' && tr.note.trim() ? tr.note.trim() : RUNNER_SAID_NOTHING_RAN
      } else {
        testsPassed = !!(tr && tr.passed)
        testsNote = null
        failedTest = typeof tr.failedTest === 'string' && tr.failedTest.trim() ? tr.failedTest.trim() : null
        failureDetail = typeof tr.failureDetail === 'string' && tr.failureDetail.trim() ? tr.failureDetail.trim() : null
        failedTests = (Array.isArray(tr.failedTests) ? tr.failedTests : [])
          .filter((s) => typeof s === 'string' && s.trim())
          .map((s) => s.trim())
        savedReport = typeof tr.savedReport === 'string' && tr.savedReport.trim() ? tr.savedReport.trim() : null
        savedLog = typeof tr.savedLog === 'string' && tr.savedLog.trim() ? tr.savedLog.trim() : null
      }
    }

    // (5a) RED -> UNDO. The branch does not enter: `merge --abort` puts the working tree back
    //      where it was, the tip never moved, and the receipt records a REFUSAL rather than a
    //      merge that went badly. If the undo ITSELF fails, that is said out loud with the
    //      command out of it — a tree left mid-merge cannot be rolled back from a journal line.
    if (testsPassed === false) {
      let unfinished = false
      try {
        execGit(['merge', '--abort'], { cwd })
        mergeInTree = false
      } catch {
        unfinished = true
      }
      const receipt = {
        branch,
        resultSha: null,
        repo: cwd,
        testsPassed: false,
        refused: true,
        reason: redRunReason(failedTest, savedReport),
        ...(failedTest ? { failedTest } : {}),
        ...(failedTests.length ? { failedTests } : {}),
        ...(failureDetail ? { failureDetail } : {}),
        ...(savedReport ? { savedReport } : {}),
        ...(savedLog ? { savedLog } : {}),
        ...(spaBuild ? { spaBuild } : {}),
        ...(unfinished ? { unfinishedMerge: true, howToClear: unfinishedMergeHint(cwd) } : {}),
      }
      try {
        appendEvent({ type: 'merge', scope: MERGE_SLOT_NAME, detail: receipt }, { terminalId, ...journalOpt(o) })
      } catch {
        /* fail-open — a journal failure never blocks the ritual */
      }
      releaseMergeClaim({ by: o.by, journalDir, ...claimOpts })
      claimed = false
      return {
        merged: false,
        testsPassed: false,
        refused: true,
        branch,
        receipt,
        ...(failedTest ? { failedTest } : {}),
        ...(failedTests.length ? { failedTests } : {}),
        ...(failureDetail ? { failureDetail } : {}),
        ...(savedReport ? { savedReport } : {}),
        ...(savedLog ? { savedLog } : {}),
        ...(unfinished ? { unfinishedMerge: true, howToClear: unfinishedMergeHint(cwd) } : {}),
      }
    }

    // (5b) GREEN, or no run at all -> record it. THIS is where the merge commit is born.
    execGit(['commit', '--no-edit'], { cwd })
    mergeInTree = false

    // the MERGE RESULT sha — read only now, because only now does it exist.
    let resultSha = ''
    try {
      resultSha = String(execGit(['rev-parse', 'HEAD'], { cwd })).trim()
    } catch {
      resultSha = ''
    }

    // (6) journal a receipt — records the outcome HONESTLY (pass OR fail; never a false green).
    //
    // THE FULL COMMIT NAME, AND THE TREE IT NAMES SOMETHING IN.
    //
    // This receipt is where one sentence comes from: the single command that undoes an
    // acceptance — `git -C <repo> revert -m 1 <sha>`. The merge above is deliberately made
    // with no fast-forward, so the merge commit always has exactly two parents and the first
    // is the trunk; that is why the side number is always 1 and why this one commit name is
    // enough to undo the whole acceptance.
    //
    // The name used to be cut to seven characters HERE, at the moment of writing. Seven is
    // usually enough, but git requires an UNAMBIGUOUS prefix and a tree large enough will one
    // day make seven ambiguous — while the full name is right there in the variable being
    // truncated. A short form, where eyes want one, is made when the value is DISPLAYED; it
    // is never the thing that gets stored. `repo` travels beside it because a person reading
    // a card is not necessarily standing in the directory the project lives in, and a command
    // that assumes they are is a command that runs somewhere else.
    const receipt = {
      branch,
      resultSha: resultSha || null,
      repo: cwd,
      testsPassed,
      ...(testsPassed === null ? { testsNote } : {}),
      // ПЕРЕСОБИРАЛОСЬ ЛИ ОКНО И СКОЛЬКО ЭТО ЗАНЯЛО — время сборки живёт только здесь.
      ...(spaBuild ? { spaBuild } : {}),
      // ЧТО РАЗВЕЛОСЬ БЕЗ ЧЕЛОВЕКА — в квитанции, потому что автоматический развод, о котором
      // никто не узнал, неотличим от слияния, где спора не было вовсе. Оговорка развода едет
      // рядом: «прошло вопреки отказу команды» — это не то же самое, что «прошло гладко».
      ...(mechanicallyResolved.length ? { mechanicallyResolved } : {}),
      ...(mechanicalNotes.length ? { mechanicalNotes } : {}),
    }
    try {
      appendEvent(
        { type: 'merge', scope: MERGE_SLOT_NAME, detail: receipt },
        { terminalId, ...journalOpt(o) },
      )
    } catch {
      /* fail-open — a journal failure never blocks the ritual */
    }

    // (7) release the slot.
    releaseMergeClaim({ by: o.by, journalDir, ...claimOpts })
    claimed = false

    return {
      merged: true,
      testsPassed,
      ...(testsPassed === null ? { testsNote } : {}),
      ...(spaBuild ? { spaBuild } : {}),
      ...(mechanicallyResolved.length ? { mechanicallyResolved } : {}),
      ...(mechanicalNotes.length ? { mechanicalNotes } : {}),
      branch,
      resultSha: resultSha || null,
      receipt,
    }
  } catch (err) {
    // C9 fail-open: UNDO the uncommitted merge first, then release any held slot, then return
    // an honest failure — never throw. The order matters: a conflict, a runner that threw and
    // a journal that refused all leave the same half-merged tree behind, and leaving it there
    // is the case the rollback law calls «откатить можно, но не видно, к чему».
    let unfinished = false
    if (mergeInTree) {
      try {
        execGit(['merge', '--abort'], { cwd })
      } catch {
        unfinished = true
      }
    }
    if (claimed) {
      try {
        releaseMergeClaim({ by: o.by, journalDir, ...claimOpts })
      } catch {
        /* best-effort */
      }
    }
    // ИМЕНА ФАЙЛОВ ЕДУТ ВПЕРЕДИ ПРОЗЫ GIT. `message` читают и человек, и классификатор отказов
    // (mergeRefusal): поставленный первым, состав конфликта попадает даже туда, где строку
    // обрезают по длине. Поля `conflictFiles`/`conflictCount` рядом — для читателя, которому
    // нужен список, а не предложение.
    const said = err && err.message ? String(err.message) : 'merge-failed'
    return {
      ok: false,
      message: conflictDetail ? `${conflictDetail.words} — ${said}` : said,
      ...(conflictDetail
        ? {
            conflict: true,
            conflictFiles: conflictDetail.conflictFiles,
            conflictCount: conflictDetail.conflictCount,
            ...(conflictDetail.conflictResolved ? { conflictResolved: conflictDetail.conflictResolved } : {}),
            ...(conflictDetail.conflictNotes ? { conflictNotes: conflictDetail.conflictNotes } : {}),
          }
        : {}),
      ...(unfinished ? { unfinishedMerge: true, howToClear: unfinishedMergeHint(cwd) } : {}),
    }
  }
}

// ── enforcing scopes — the verified-LIVE-only soft-deny predicate ───────────────────
//
// enforceScope is the SOFT-deny-with-override predicate. It fires (soft-deny + override)
// ONLY on a VERIFIED-LIVE foreign claim — the SAME evidence logic as the
// self-verifying collision banner (verifyClaimEvidence): a claim is STALE (safe to take) when the
// scope is CLEAN vs HEAD AND a commit landed in scope after the claim's renewTime; only
// otherwise is it LIVE (real busy). A stale/unverified claim stays WARN-only. Posture:
//   - SOFT-deny-with-override ONLY — NEVER a hard block (hard deny stays the security
//     guard's alone, carried posture lock).
//   - Any error degrades to ALLOW (C9 fail-open) — a gate bug can NEVER wedge a session.
//   - A cooling-down / force-cleared scope is NEVER enforced — the founder word
//     always wins.
// The stream GATE (default ON; kill-switch SMA_ENFORCE_SCOPES_DISABLE) lives in the pre.mjs
// `enforce` stream, NOT here — so this predicate stays a pure evidence->action function.

/**
 * enforceScope({ownTouch, foreignClaim, evidence, env, verifyClaimEvidence, coolingDown})
 * — decide the enforcing action for an Edit/Write that overlaps a foreign claim.
 *   - no foreign claim                       -> {action:'allow'}
 *   - SMA_ENFORCE_SCOPES_DISABLE set          -> {action:'allow'} (kill-switch, before any evidence read)
 *   - cooling-down / force-cleared scope      -> {action:'warn'}  (founder word wins)
 *   - foreign claim STALE/unverified          -> {action:'warn', text}
 *   - foreign claim VERIFIED-LIVE             -> {action:'soft-deny', text, override}
 * Deterministic over the injected evidence + verifyClaimEvidence (the ONE evidence
 * source). Any error -> {action:'allow'} (fail-open). NEVER a hard block.
 * @returns {{action:'allow'|'warn'|'soft-deny', text?:string, override?:string}}
 */
export function enforceScope(o = {}) {
  try {
    const env = o.env || {}
    // Kill-switch short-circuits BEFORE any evidence read (fail-open ceiling).
    if (envOn(env.SMA_ENFORCE_SCOPES_DISABLE)) return { action: 'allow' }

    const foreignClaim = o.foreignClaim
    if (!foreignClaim) return { action: 'allow' } // no overlap -> nothing to enforce

    // NEVER enforce a cooling-down / force-cleared scope — the founder word wins.
    if (o.coolingDown) {
      return { action: 'warn', text: 'скоуп недавно освобождён — можно занимать (не блокируем)' }
    }

    // The verified-LIVE-vs-stale decision — verifyClaimEvidence, ONE source.
    const verify = typeof o.verifyClaimEvidence === 'function' ? o.verifyClaimEvidence : null
    const ev = verify ? verify(o.evidence || {}) : { live: true, text: '' }

    if (ev && ev.live === false) {
      // STALE / unverified foreign claim -> WARN-only (never a soft-deny).
      return { action: 'warn', text: ev.text || 'claim устарел — можно работать' }
    }

    // VERIFIED-LIVE foreign claim -> SOFT-deny with an override token (never a hard block).
    return {
      action: 'soft-deny',
      text: ev && ev.text ? ev.text : `занято ${foreignClaim.by || foreignClaim.holderIdentity || 'другим терминалом'}`,
      override: ENFORCE_OVERRIDE_HINT,
    }
  } catch {
    return { action: 'allow' } // C9 fail-open — never deny on error, never a wedge.
  }
}

export { envOn as _envOn }
