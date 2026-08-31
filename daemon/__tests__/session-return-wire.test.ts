/**
 * ВОЗВРАТ В СЕССИЮ РАБОТНИКА — ПРОВОД ОТ СТРОКИ РЕЕСТРА ДО СТРОКИ, КОТОРУЮ ЧЕЛОВЕК ВСТАВИТ В ТЕРМИНАЛ.
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ. Машинная половина этой истории закрыта давно: продолжение попытки
 * поднимает ТУ ЖЕ сессию (`--resume <sessionId>`), а идентификатор лежит в строке реестра.
 * Человеческой половины не было вовсе — идентификатор до окна не доезжал, и «зайти в сессию
 * работника и посмотреть самому» оставалось возможностью, о которой знал только демон. Это тот
 * же класс дефекта, что уже случался в этом дереве: вычислено, записано и никому не отдано.
 *
 * ДВА ОТРЕЗКА ПРОВОДА, И КАЖДЫЙ СО СВОИМ ХОЗЯИНОМ:
 *
 *   (1) ДВЕРЬ. `GET /api/task/:id` называет `sessionId` попытки и каталог аккаунта, под которым
 *       она шла. Идентификатор едет наружу ТОЛЬКО пригодный к продолжению — форму спрашивают у
 *       того же предиката, которым её спрашивает сборщик аргументов, а не у второго написания
 *       правила. Аккаунт нужен потому, что сессия лежит в НЁМ: без него команда, вставленная в
 *       терминал человека, честно не найдёт ничего.
 *
 *   (2) КАРТОЧКА. Чистый модуль окна собирает ОДНУ строку под ту оболочку, в которой её будут
 *       набирать, — и молчит везде, где выдумывать пришлось бы: нет сессии, неизвестна система,
 *       чужая полоса. Молчание проверяется отдельными случаями, потому что именно оно и есть
 *       обещание «ничего не выдумываем».
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Проверки того, что CLI действительно поднимет сессию: это утверждение о чужой
 * командной строке, и доказать его может только живой прогон, а не сьют.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { createFrontServer } from '../src/front/server.mjs'
import { derivePhaseCard, derivePhaseIndex } from '../src/front/state.mjs'
import { sessionReturn, RETURN_COPY_GONE, RETURN_NO_ACCOUNT } from '../../spa/src/screens/task-card/session-return'
import type { TaskAttempt } from '../../spa/src/api/types'

const TOKEN = 'f'.repeat(64)

/** Идентификатор той формы, которую командная строка принимает к продолжению. */
const SESSION = '2f1c9a44-6b7e-4a51-9d3f-8c0e5b71a2d4'
const ACCOUNT_DIR = '~/.sma-accounts/max-1'
const COPY = '/tmp/copies/wt-task-1'

// ── временный проект ───────────────────────────────────────────────────────────────────────

const tmpDirs: string[] = []
function mkProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sma-return-'))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* уборка не роняет сьют */
    }
  }
})

// ── поддельные req/res (та же форма, которой ведут двери соседние сьюты) ────────────────────

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body, remote = '10.0.0.9' } = o
  const payload = body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req: any = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = { ...headers }
  req.socket = { remoteAddress: remote }
  return req
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, any>,
    body: '',
    headersSent: false,
    writeHead(code: number, h?: any) {
      res.statusCode = code
      res.headersSent = true
      if (h) for (const [k, v] of Object.entries(h)) res.headers[k.toLowerCase()] = v
      return res
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      res.ended = true
      return res
    },
  }
  return res
}

async function call(front: any, url: string) {
  const req = mkReq({ url, headers: { authorization: `Bearer ${TOKEN}` } })
  const res = mkRes()
  await front.handle(req, res)
  return res
}

/** Дверь, подключённая ровно теми сотрудниками, которых спрашивает ответ карточки. */
function mkFront({ rows = [], attempts = [], workers = [] as any[] } = {}) {
  const projectDir = mkProject()
  return createFrontServer({
    config: { token: TOKEN, repoDir: projectDir, workers },
    deps: {
      repoDir: projectDir,
      clock: () => 1_770_000_000_000,
      adapter: { list: async () => rows },
      ledger: {
        readAttempts: () => attempts,
        readAttemptLog: () => ({ entries: [], truncated: false, roles: [], rolesMore: 0, digest: null }),
        readJournalEntries: () => [],
      },
      derivePhaseCard,
      derivePhaseIndex,
    },
  })
}

const WORKERS = [{ id: 'max-1', lane: 'prod', account: { configDir: ACCOUNT_DIR } }]

const doneRow = (id: string) => ({ id, status: 'completed', lane: 'prod', title: 'дело', attempt: 1, priority: 0 })

// ═══════════ (1) ДВЕРЬ ЗАДАЧИ ══════════════════════════════════════════════════════════════

describe('GET /api/task/:id — сессия попытки и её аккаунт доезжают до окна', () => {
  it('пригодный к продолжению идентификатор и каталог аккаунта названы на подходе', async () => {
    const front = mkFront({
      rows: [doneRow('BL-701')],
      attempts: [
        { attempt: 1, outcome: 'completed', workerId: 'max-1', provider: 'claude', sessionId: SESSION, worktreePath: COPY },
      ],
      workers: WORKERS,
    })

    const res = await call(front, '/api/task/BL-701')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.attempts[0].sessionId).toBe(SESSION)
    expect(body.attempts[0].accountDir).toBe(ACCOUNT_DIR)
  })

  it('идентификатор не той формы наружу не едет — окну нечего было бы с ним делать', async () => {
    const front = mkFront({
      rows: [doneRow('BL-702')],
      attempts: [{ attempt: 1, outcome: 'failed', workerId: 'max-1', sessionId: 'сессия-которой-нет' }],
      workers: WORKERS,
    })

    const body = JSON.parse((await call(front, '/api/task/BL-702')).body)
    expect(body.attempts[0].sessionId).toBe(null)
  })

  it('работника этой строки в настройках больше нет → каталог аккаунта молчит, а не выдумывается', async () => {
    const front = mkFront({
      rows: [doneRow('BL-703')],
      attempts: [{ attempt: 1, outcome: 'failed', workerId: 'ghost-9', sessionId: SESSION }],
      workers: WORKERS,
    })

    const body = JSON.parse((await call(front, '/api/task/BL-703')).body)
    expect(body.attempts[0].sessionId).toBe(SESSION)
    expect(body.attempts[0].accountDir).toBe(null)
  })

  it('идущая попытка несёт ту же форму — оба поля названы нулями, а не опущены', async () => {
    const front = mkFront({
      rows: [{ id: 'BL-704', status: 'claimed', lane: 'prod', title: 'дело', attempt: 1, priority: 0, workerId: 'max-1' }],
      attempts: [],
      workers: WORKERS,
    })

    const body = JSON.parse((await call(front, '/api/task/BL-704')).body)
    const live = body.attempts[body.attempts.length - 1]
    expect(live.outcome).toBe('running')
    expect(live.sessionId).toBe(null)
    expect(live.accountDir).toBe(null)
  })
})

// ═══════════ (2) КАРТОЧКА ══════════════════════════════════════════════════════════════════

/** Попытка в той форме, в какой её отдаёт дверь; названо только то, что читает эта панель. */
function attempt(o: Partial<TaskAttempt>): TaskAttempt {
  return {
    attempt: 1,
    workerId: 'max-1',
    provider: 'claude',
    startedAt: null,
    endedAt: '2026-08-30T10:00:00Z',
    outcome: 'failed',
    failureReason: null,
    reasonLabel: null,
    receipt: null,
    sessionId: SESSION,
    accountDir: ACCOUNT_DIR,
    worktreePath: COPY,
    ...o,
  } as TaskAttempt
}

describe('строка возврата в сессию работника', () => {
  it('под оболочкой Windows — каталог, аккаунт и продолжение одной строкой', () => {
    const out = sessionReturn(attempt({}), 'win32')!
    expect(out.command).toBe(`cd "${COPY}"; $env:CLAUDE_CONFIG_DIR="${ACCOUNT_DIR}"; claude --resume ${SESSION}`)
    expect(out.notes).toEqual([])
  })

  it('под остальными — та же строка их собственным письмом', () => {
    const out = sessionReturn(attempt({}), 'darwin')!
    expect(out.command).toBe(`cd "${COPY}" && CLAUDE_CONFIG_DIR="${ACCOUNT_DIR}" claude --resume ${SESSION}`)
  })

  it('сессии нет — панели нет: прочерк вместо команды врал бы, будто зайти некуда', () => {
    expect(sessionReturn(attempt({ sessionId: null }), 'win32')).toBe(null)
  })

  it('система неизвестна — строка не собирается: оболочку не угадывают', () => {
    expect(sessionReturn(attempt({}), null)).toBe(null)
  })

  it('чужая полоса — молчание: продолжение там зовётся другой командой', () => {
    expect(sessionReturn(attempt({ provider: 'codex' }), 'win32')).toBe(null)
  })

  it('копия убрана — команда есть, но сказано, что каталога больше нет', () => {
    const out = sessionReturn(
      attempt({ cleanup: { at: '2026-08-30T11:00:00Z', by: 'approve', removedPath: COPY, removedBranch: null, ok: true } }),
      'win32',
    )!
    expect(out.notes).toContain(RETURN_COPY_GONE)
  })

  it('аккаунт не назван — приставки в строке нет, и об этом сказано словами', () => {
    const out = sessionReturn(attempt({ accountDir: null }), 'darwin')!
    expect(out.command).toBe(`cd "${COPY}" && claude --resume ${SESSION}`)
    expect(out.notes).toContain(RETURN_NO_ACCOUNT)
  })

  it('копии в записи нет — остаётся продолжение без перехода в каталог', () => {
    const out = sessionReturn(attempt({ worktreePath: null }), 'win32')!
    expect(out.command).toBe(`$env:CLAUDE_CONFIG_DIR="${ACCOUNT_DIR}"; claude --resume ${SESSION}`)
  })
})
