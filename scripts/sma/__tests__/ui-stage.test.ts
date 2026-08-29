/**
 * ui-stage.test.ts — the live window scene: its grammar, and the WIRE it exists for.
 *
 * The wire cases spawn the real command. That is the coverage, not an accident of style:
 * every defect this scene was built against — a door on somebody else's port, a token in a
 * file, a process still serving after the check was over — is a fact about a PROCESS, and
 * an in-process double would answer each of them from the very assumption under test.
 *
 * The browser is the one thing standing in: SMA_UI_DRIVER points at fixtures/fake-ui-driver.mjs,
 * which makes REAL requests against the address the scene printed and writes a real file where
 * a screenshot goes. So the chain proved here is the whole chain except the rendering — the
 * scene raised, the address handed to the run engine, the door answering 200 on a socket, a
 * receipt on disk — and the machine running it needs no browser to prove it.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  STAGE_ACTIVE_PROJECT,
  STAGE_CHAT_TURNS,
  STAGE_HOST,
  STAGE_PROJECTS,
  URL_ENV,
  announcement,
  missingBuildMessage,
  parseStageArgs,
  stageCommandArgs,
  stageConfig,
  stageDiskConfig,
  stageProjectFiles,
  stageProjects,
  stageUrl,
} from '../lib/ui-stage.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const STAGE = join(ROOT, 'scripts', 'sma', 'ui-stage.mjs')
const DRIVE = join(ROOT, 'scripts', 'sma', 'ui-drive.mjs')
const FAKE_DRIVER = join(ROOT, 'scripts', 'sma', '__tests__', 'fixtures', 'fake-ui-driver.mjs')

/** The port the real daemon stands on by default — the one this scene may never take. */
const DAEMON_DEFAULT_PORT = 7777
/** …and the directory it keeps its config and its token in. */
const DAEMON_HOME = join(homedir(), '.sma-daemon')

type Announced = { url: string; port: number; dir: string; token: string; receipts: string }

/** Read the scene's own words back: the address, the port, the directory, the receipts root. */
function announced(out: string): Announced {
  const url = (out.match(/address:\s+(\S+)/) || [])[1] || ''
  const port = Number((out.match(/port:\s+(\d+)/) || [])[1] || 0)
  const dir = ((out.match(/^\s+dir:\s+(.+)$/m) || [])[1] || '').trim()
  const receipts = ((out.match(/receipts:\s+(.+?)\s+\(outside/) || [])[1] || '').trim()
  const token = (url.match(/token=([a-f0-9]+)/) || [])[1] || ''
  return { url, port, dir, token, receipts }
}

/** The address the run engine printed for its own receipt — absolute, on the last line. */
function receiptPath(out: string): string {
  return ((out.match(/^Receipt:\s+(.+)$/m) || [])[1] || '').trim()
}

/**
 * Ask the live scene a question the way a browser does: mint the session cookie off the
 * printed address, then call the door. The point of every wire case below is that the answer
 * comes off a SOCKET — a door that refuses is a fact about the running scene, and no
 * in-process double can be asked it.
 */
async function ask(url: string, path: string, init: RequestInit = {}) {
  const first = await fetch(url, { redirect: 'manual', headers: { connection: 'close' } })
  const cookie = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  const origin = new URL(url).origin
  const res = await fetch(origin + path, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie, connection: 'close' },
  })
  return { status: res.status, text: await res.text() }
}

/** Raise a holding scene, hand its announcement to `body`, and take it down again. */
async function onStage(body: (a: Announced) => Promise<void>): Promise<void> {
  const cwd = scratchDir()
  const child = spawn(process.execPath, [STAGE], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)))
  try {
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`the scene never announced itself: ${out}`)), 30000)
      child.stdout.on('data', (b) => {
        out += String(b)
        if (out.includes('Holding.')) {
          clearTimeout(timer)
          done()
        }
      })
      child.stderr.on('data', (b) => (out += String(b)))
      child.on('exit', () => {
        clearTimeout(timer)
        fail(new Error(`the scene died before it was up: ${out}`))
      })
    })
    await body(announced(out))
  } finally {
    child.kill('SIGTERM')
    await exited
  }
}

/** Every file under a directory, recursively — used to prove an ABSENCE (see the token case). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(String(e.parentPath ?? dir), e.name))
}

/** Can anything still be connected to on this port? The door's own liveness, not a claim. */
function portAnswers(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((done) => {
    const sock = createConnection({ port, host: STAGE_HOST })
    let settled = false
    const finish = (v: boolean) => {
      if (settled) return
      settled = true
      try {
        sock.destroy()
      } catch {
        /* already gone */
      }
      done(v)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

const scratch: string[] = []
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sma-ui-stage-case-'))
  scratch.push(dir)
  return dir
}

describe('parseStageArgs — the whole grammar, and what it deliberately refuses', () => {
  it('with nothing at all, the scene raises and holds', () => {
    expect(parseStageArgs([])).toEqual({ ok: true, hold: true, command: [] })
  })

  it('takes everything after «--» as the command to run under the window', () => {
    const parsed = parseStageArgs(['--', 'node', 'ui-drive.mjs', '{url}'])
    expect(parsed).toEqual({ ok: true, hold: false, command: ['node', 'ui-drive.mjs', '{url}'] })
  })

  it('refuses «--» with nothing after it rather than raising a window for nobody', () => {
    const parsed = parseStageArgs(['--'])
    expect(parsed.ok).toBe(false)
    expect((parsed as { error: string }).error).toMatch(/no command/)
  })

  it('refuses a named port — the one flag whose whole purpose would be to land on the daemon', () => {
    const parsed = parseStageArgs(['--port', '7777'])
    expect(parsed.ok).toBe(false)
    expect((parsed as { error: string }).error).toContain('--port')
  })
})

describe('the address the run engine is handed', () => {
  it('is loopback and carries the token, because a url is all the engine takes', () => {
    expect(stageUrl({ port: 41234, token: 'abc' })).toBe('http://127.0.0.1:41234/?token=abc')
  })

  it('fills every {url} in the trailing command, and leaves the rest alone', () => {
    expect(stageCommandArgs(['node', 'drive.mjs', '{url}', '--no-sweep'], 'http://x/')).toEqual([
      'node',
      'drive.mjs',
      'http://x/',
      '--no-sweep',
    ])
  })

  it('hands the command an address it can also read out of its environment', () => {
    expect(URL_ENV).toBe('SMA_STAGE_URL')
  })
})

describe('the scene config — made in memory, standing on nothing the daemon owns', () => {
  it('binds loopback only, and inherits no queue: a window, never a fleet', () => {
    const config = stageConfig({ port: 0, token: 't' })
    expect(config.bind).toBe(STAGE_HOST)
    expect(config.queueUrl).toBeUndefined()
    expect(config.workers).toEqual([])
  })

  it('carries the port it was given, so the caller writes back the one the socket took', () => {
    expect(stageConfig({ port: 51000, token: 't' }).port).toBe(51000)
  })

  /**
   * ФАЙЛ СЦЕНЫ НАМЕРЕННО НЕ СОВПАДАЕТ С КОПИЕЙ В ПАМЯТИ. Настройки второго класса
   * применяются только с нового запуска демона, и увидеть, как окно об этом говорит, можно
   * лишь там, где два значения РАЗНЫЕ: совпадающая пара доказывала бы, что экран умеет
   * молчать. Токена в файле нет и быть не может — это отдельный закон сцены.
   */
  it('the scene’s file on disk differs from its in-memory copy, and carries no token', () => {
    const memory = stageConfig({ port: 0, token: 't' })
    const disk: any = stageDiskConfig()

    expect(disk.maxConcurrentAttempts).toBe(4)
    expect(disk.pipeline.maxTurns).toBe(400)
    expect(disk.maxConcurrentAttempts).not.toBe((memory as any).maxConcurrentAttempts)
    expect(disk.token, 'the scene token meets no file — showing a divergence does not lift that').toBeUndefined()
  })

  it('carries the registry it is handed — the four read models all start at a connected tree', () => {
    const projects = stageProjects('/scene')
    const config = stageConfig({ port: 0, token: 't', projects, activeProject: STAGE_ACTIVE_PROJECT })
    expect(config.projects).toHaveLength(2)
    expect(config.activeProject).toBe(STAGE_ACTIVE_PROJECT)
  })

  it('invents no registry of its own: no trees passed, no trees served', () => {
    const config = stageConfig({ port: 0, token: 't' })
    expect(config.projects).toEqual([])
    expect(config.activeProject).toBeUndefined()
  })
})

describe('the kit — two trees, deliberately unalike', () => {
  it('roots every tree inside the scene’s own directory, and names nothing outside it', () => {
    for (const p of stageProjects('/scene')) {
      expect(p.path.startsWith(join('/scene', 'projects'))).toBe(true)
      expect(p.id).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(p.name.length).toBeGreaterThan(0)
    }
  })

  it('gives BOTH trees a backlog and a profile — one tree is not a switch to test', () => {
    expect(STAGE_PROJECTS).toHaveLength(2)
    for (const p of STAGE_PROJECTS) {
      const files = stageProjectFiles(p.id).map((f) => f.path.join('/'))
      expect(files, p.id).toContain('.planning/BACKLOG.md')
      // The profile is what tells the window the house is set up; without it every run has to
      // remember to walk past the first-run interview before it can look at anything.
      expect(files, p.id).toContain('.sma/profile.json')
    }
  })

  it('makes the two boards DIFFERENT, because a switch that changes nothing proves nothing', () => {
    const board = (id: string) => stageProjectFiles(id).find((f) => f.path.join('/') === '.planning/BACKLOG.md')?.text ?? ''
    expect(board(STAGE_PROJECTS[0].id)).not.toBe(board(STAGE_PROJECTS[1].id))
  })

  it('writes rows in the shape the board parses by, and marks one done so the derive can drop it', () => {
    const text = stageProjectFiles(STAGE_PROJECTS[0].id).find((f) => f.path.join('/') === '.planning/BACKLOG.md')!.text
    expect(text).toMatch(/^- \*\*[A-Z][A-Z0-9]{1,7}-\d{1,6}\*\* /m)
    expect(text).toMatch(/^- \[x\] \*\*/m)
  })

  it('stamps every fixture turn with the tree it was said under, so the conversation narrows', () => {
    const ids = new Set(STAGE_CHAT_TURNS.map((t) => t.project))
    expect([...ids].sort()).toEqual(STAGE_PROJECTS.map((p) => p.id).sort())
  })

  it('answers an unknown tree with an empty one rather than throwing at the command that raises it', () => {
    expect(stageProjectFiles('nobody')).toEqual([])
  })
})

describe('the words for a state the scene refuses to fix by itself', () => {
  it('a missing build is NOT RUN with the one command that fixes it — never a silent build', () => {
    const said = missingBuildMessage('/somewhere/app')
    expect(said).toMatch(/NOT RUN/)
    expect(said).toContain('npm run build:spa')
    expect(said).toContain('/somewhere/app')
  })

  it('the announcement prints the port and the directory, so the claim is checkable', () => {
    const said = announcement({ url: 'http://127.0.0.1:9/?token=t', port: 9, dir: '/tmp/scene' })
    expect(said).toContain('port:    9')
    expect(said).toContain('/tmp/scene')
    expect(said).toMatch(/written to no file/)
  })

  it('names the trees and the receipts root — an artifact nobody can find is no artifact', () => {
    const said = announcement({
      url: 'http://127.0.0.1:9/?token=t',
      port: 9,
      dir: '/tmp/scene',
      projects: stageProjects('/tmp/scene'),
      receipts: '/tmp/sma-ui-receipts',
    })
    expect(said).toContain(STAGE_PROJECTS[0].name)
    expect(said).toContain(STAGE_PROJECTS[1].id)
    expect(said).toContain('/tmp/sma-ui-receipts')
    expect(said).toMatch(/outlives this scene/)
  })

  it('says nothing about trees or receipts it was not given, rather than printing a blank line', () => {
    const said = announcement({ url: 'http://127.0.0.1:9/?token=t', port: 9, dir: '/tmp/scene' })
    expect(said).not.toContain('trees:')
    expect(said).not.toContain('receipts:')
  })
})

describe('the wire: one command raises the window, the run engine photographs it, nothing is left behind', () => {
  it(
    'the scene, the address, the door and the receipt are one chain — and the port belongs to nobody else',
    async () => {
      const cwd = scratchDir()
      const record = join(cwd, 'visits.json')
      const run = await new Promise<{ code: number | null; out: string }>((done) => {
        const child = spawn(
          process.execPath,
          [STAGE, '--', process.execPath, DRIVE, '{url}', '--no-sweep', '--min-viewport', '1440'],
          {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, SMA_UI_DRIVER: FAKE_DRIVER, SMA_FAKE_DRIVER_RECORD: record },
          }
        )
        let out = ''
        child.stdout.on('data', (b) => (out += String(b)))
        child.stderr.on('data', (b) => (out += String(b)))
        child.on('exit', (code) => done({ code, out }))
      })

      // The run engine's own verdict rode back as the scene's exit code — the wrapper adds a
      // window, never an opinion about what was seen through it.
      expect(run.code, run.out).toBe(0)

      const { port, dir, token, receipts } = announced(run.out)
      expect(port).toBeGreaterThan(0)
      expect(port).not.toBe(DAEMON_DEFAULT_PORT)
      expect(dir.startsWith(DAEMON_HOME)).toBe(false)
      expect(dir.startsWith(tmpdir())).toBe(true)
      expect(token.length).toBe(64)

      // THE DOOR ANSWERED, on a real socket, at the address the scene printed: 302 for the
      // bootstrap exchange, then 200 for the window behind the cookie it minted.
      const visits = JSON.parse(readFileSync(record, 'utf8'))
      expect(visits.map((v: { status: number }) => v.status)).toEqual([302, 200])
      expect(visits[0].url).toContain(String(port))

      // THE RECEIPT LANDED OUTSIDE THE WORKING COPY, AND THE PATH WAS PRINTED — both halves
      // matter and only the pair is useful. A run made in a throwaway copy used to write its
      // verdict and its screenshots INTO that copy, which acceptance then removed: the one
      // artifact proving the window worked stopped existing at the moment somebody read for it.
      const receipt = receiptPath(run.out)
      expect(receipt, run.out).not.toBe('')
      expect(isAbsolute(receipt)).toBe(true)
      expect(receipt.startsWith(receipts)).toBe(true)
      expect(receipt.startsWith(cwd)).toBe(false)
      expect(existsSync(join(cwd, '.planning'))).toBe(false)
      expect(existsSync(receipt)).toBe(true)

      // …and there is a picture beside it.
      const shots = filesUnder(dirname(receipt)).filter((f) => f.endsWith('.png'))
      expect(shots.length).toBeGreaterThan(0)
      expect(statSync(shots[0]).size).toBeGreaterThan(0)

      // UPKEEP AT THE NORMAL END: the directory the scene made is gone with it — and the
      // receipts root, deliberately, is NOT. Evidence whose lifetime is the scene's lifetime
      // is evidence nobody can read afterwards.
      expect(existsSync(dir)).toBe(false)
      expect(existsSync(receipts)).toBe(true)
    },
    60000
  )

  it(
    'holds the window open, writes its token into no file, and does not survive a signal',
    async () => {
      const cwd = scratchDir()
      const child = spawn(process.execPath, [STAGE], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)))
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`the scene never announced itself: ${out}`)), 20000)
        child.stdout.on('data', (b) => {
          out += String(b)
          if (out.includes('Holding.')) {
            clearTimeout(timer)
            done()
          }
        })
        child.stderr.on('data', (b) => (out += String(b)))
        child.on('exit', () => {
          clearTimeout(timer)
          fail(new Error(`the scene died before it was up: ${out}`))
        })
      })

      const { url, port, dir, token } = announced(out)
      // The window itself, behind the token — 200 and the app's own page, not a stub.
      const page = await fetch(new URL('/', url), {
        headers: { authorization: `Bearer ${token}`, connection: 'close' },
      })
      expect(page.status).toBe(200)
      expect((await page.text()).toLowerCase()).toContain('<!doctype html>')

      // THE TOKEN IS IN NO FILE. Everything the scene could have written lives under the one
      // directory it announced; not one byte of it carries the credential.
      for (const file of filesUnder(dir)) {
        expect(readFileSync(file, 'utf8').includes(token), file).toBe(false)
      }

      // UPKEEP ON AN INTERRUPTION: the process dies and takes the door with it. A scene that
      // outlives its signal is the defect this command was written against — a stranger's run
      // once broke on a daemon a finished check had left standing.
      child.kill('SIGTERM')
      await exited
      expect(await portAnswers(port)).toBe(false)
    },
    60000
  )

  it(
    'the four doors that used to answer «не реализовано» answer for real — asked of the live scene',
    async () => {
      await onStage(async ({ url }) => {
        // MEASURED ON THE RAISED SCENE, not read off the source. Each of these four is a read
        // model whose collaborator the first scene did not wire, so each answered 501 — and a
        // worker taking the scene to check «Задачи» or «Бэклог» got a red verdict about work
        // that was never theirs and went hunting a defect that did not exist.
        for (const path of ['/api/chat/history?limit=10', '/api/backlog', '/api/coordination', '/api/harness']) {
          const got = await ask(url, path)
          expect(got.status, `${path} → ${got.text}`).toBe(200)
          expect(got.text).not.toContain('not implemented')
        }

        // …and «answers» means «has something to read», not «returns an empty shape».
        const backlog = JSON.parse((await ask(url, '/api/backlog')).text)
        expect(backlog.rows.length).toBeGreaterThan(0)
        // The ticked row of the fixture is NOT on the board: a board that showed it would be a
        // history. That is the derive's own rule, proved here on the file the scene wrote.
        expect(backlog.rows.some((r: { id: string }) => r.id === 'SCN-4')).toBe(false)

        // The ledger is written by the runtime's own writers and read back by the daemon's own
        // reader — so a fixture that showed rows here could not be showing a shape of its own.
        const coord = JSON.parse((await ask(url, '/api/coordination')).text)
        expect(coord.sessions.length).toBeGreaterThan(0)
        expect(coord.claims.length).toBeGreaterThan(0)
        expect(coord.collisions.length).toBeGreaterThan(0)

        const chat = JSON.parse((await ask(url, '/api/chat/history?limit=10')).text)
        expect(chat.turns.length).toBeGreaterThan(0)

        const harness = JSON.parse((await ask(url, '/api/harness')).text)
        expect(harness.skills.length).toBeGreaterThan(0)
        // Both stores are NAMED and both are inside the scene: an unnamed machine store
        // resolves to the operator's own ~/.claude, and the scene would be reading their tree.
        for (const store of [...harness.skillStores, ...harness.agentStores]) {
          expect(store.path.startsWith(homedir() + '/.claude'), store.path).toBe(false)
          expect(store.path.startsWith(join(homedir(), '.claude')), store.path).toBe(false)
        }
      })
    },
    60000
  )

  it(
    'brings two trees and lets a run move between them — and the screen behind the switch changes',
    async () => {
      await onStage(async ({ url, dir, token }) => {
        const before = JSON.parse((await ask(url, '/api/projects')).text)
        expect(before.projects.length).toBeGreaterThanOrEqual(2)
        expect(before.activeProject).toBe(STAGE_ACTIVE_PROJECT)

        const other = STAGE_PROJECTS[1].id
        const moved = await ask(url, '/api/project/select', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: other }),
        })
        expect(moved.status, moved.text).toBe(200)

        // THE SWITCH HAS TO SHOW. The two-tree case is the treacherous one — work routed to the
        // tree the code is not in — and a switcher whose screens look identical either way
        // tells a run nothing about whether the switch happened.
        const after = JSON.parse((await ask(url, '/api/projects')).text)
        expect(after.activeProject).toBe(other)
        const board = JSON.parse((await ask(url, '/api/backlog')).text)
        expect(board.rows.length).toBeGreaterThan(0)
        expect(board.rows.some((r: { id: string }) => r.id === 'SCN-1')).toBe(false)
        // The second tree is a QUIET checkout, and an empty panel over one is an honest 200.
        expect(JSON.parse((await ask(url, '/api/coordination')).text).sessions).toEqual([])

        // AND THE PEN STAYED OFF WHERE IT MATTERS. Раньше здесь стояло «файла настроек в
        // каталоге нет вовсе», и это было верно ровно до того дня, когда сцена начала класть
        // такой файл НАРОЧНО: он показывает расхождение между диском и памятью, из-за которого
        // настройка второго класса выглядела применённой. Запрет остался прежним по существу и
        // стал точнее по букве: боялись мы не файла, а ТОКЕНА в файле, который первое же
        // нажатие вписало бы туда навсегда. Проверяется теперь именно он — во ВСЕХ файлах
        // сцены, а не в одном по имени.
        for (const file of filesUnder(dir)) {
          expect(readFileSync(file, 'utf8').includes(token), `${file} несёт токен сцены`).toBe(false)
        }

        const unknown = await ask(url, '/api/project/select', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'nobody' }),
        })
        expect(unknown.status).toBe(404) // the production applier's own named refusal, unchanged
      })
    },
    60000
  )
})

// The scratch trees the cases worked in. The scene's OWN directory is not swept here on
// purpose: that it is already gone is an assertion above, not this hook's job.
process.on('exit', () => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leftover in the system temp dir is not worth a red run */
    }
  }
})
