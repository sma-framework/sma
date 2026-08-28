/**
 * fake-ui-driver.mjs — a stand-in for the browser driver `ui-drive.mjs` resolves at run
 * time through SMA_UI_DRIVER. It exists so the WIRE — a scene raised, its address handed
 * over, a receipt written — can be proved on any machine, including one with no browser.
 *
 * IT STANDS IN FOR THE BROWSER AND FOR NOTHING ELSE. `goto` performs REAL requests against
 * the address it was handed: the bootstrap exchange first, then the page behind the cookie
 * that exchange minted, exactly as a browser does. So a green run through this driver means
 * the door really answered, on a real socket, at that address — the only faked part is the
 * rendering, and what ui-drive measures off a rendered page comes back as a still, healthy
 * page. Whether a real window PAINTS is a question for a run with a real driver; this one
 * answers whether the scene, the address and the receipt are connected to each other.
 *
 * Every visit is recorded, with the status the door answered, into the file named by
 * SMA_FAKE_DRIVER_RECORD — so a test asserts the status rather than inferring it from
 * a verdict.
 *
 * `connection: close` on every request is deliberate. A pooled keep-alive socket, left open
 * by a process that exits abruptly, aborts the server on the other side (measured on Node 24
 * / Windows: an assertion inside libuv's async.c instead of an exit code). A stand-in must
 * not hand the thing it stands in for a failure of its own making.
 */

import { writeFileSync } from 'node:fs'

/** The PNG signature and nothing else: a real file on disk, honest about being a stub. */
const PNG_STUB = Buffer.from('89504e470d0a1a0a', 'hex')

/** A page that has stopped changing — the shape awaitReady samples for. */
const STILL_PAGE = { nodes: 120, ink: 480 }

const visits = []

function record(entry) {
  visits.push(entry)
  const file = process.env.SMA_FAKE_DRIVER_RECORD
  if (file) writeFileSync(file, `${JSON.stringify(visits, null, 2)}\n`)
}

/** The cookies a response set, folded into one Cookie header — the browser's whole job here. */
function jarOf(res) {
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  return set.map((c) => String(c).split(';')[0]).join('; ')
}

function makePage() {
  let jar = ''
  return {
    on() {
      /* no events: a page that renders nothing has nothing to report */
    },
    async goto(target) {
      const headers = { connection: 'close', ...(jar ? { cookie: jar } : {}) }
      const first = await fetch(target, { redirect: 'manual', headers })
      record({ url: String(target), status: first.status })
      await first.arrayBuffer()
      if (first.status >= 300 && first.status < 400) {
        jar = jarOf(first) || jar
        const next = new URL(first.headers.get('location') || '/', target)
        const second = await fetch(next, { headers: { connection: 'close', ...(jar ? { cookie: jar } : {}) } })
        record({ url: next.toString(), status: second.status })
        await second.arrayBuffer()
        if (!second.ok) throw new Error(`the door answered ${second.status}`)
        return
      }
      if (!first.ok) throw new Error(`the door answered ${first.status}`)
    },
    async evaluate(_fn, arg) {
      // Readiness samples with no argument; the overflow scan passes its limits. Nothing is
      // rendered here, so the scan measures nothing rather than inventing a clean box.
      return arg === undefined ? STILL_PAGE : []
    },
    async waitForTimeout(ms) {
      await new Promise((r) => setTimeout(r, Math.min(Number(ms) || 0, 500)))
    },
    async screenshot({ path }) {
      writeFileSync(path, PNG_STUB)
    },
    locator() {
      return { all: async () => [] }
    },
    async close() {
      /* nothing was opened */
    },
  }
}

export const chromium = {
  async launch() {
    return {
      async newPage() {
        return makePage()
      },
      async close() {
        /* nothing was launched */
      },
    }
  },
}

export default { chromium }
