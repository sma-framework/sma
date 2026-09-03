/**
 * КАРТОЧКА СТУПЕНИ ФАЗЫ ГОВОРИТ СЛОВАМИ, А НЕ КОМАНДНОЙ СТРОКОЙ.
 *
 * ═══════════════ ЧТО БЫЛО НЕ ТАК ═══════════════
 *
 * Дверь, ставящая ступень фазы, писала ей заголовком РОВНО ТУ СТРОКУ, которой ступень
 * запускается, — и в столбике «ждут вас» стояла карточка `/sma-discuss-phase 21 --batch --text`.
 * Слова основателя, 31.08: «висит /sma-discuss-phase… какое-то непонятное задание». Человек,
 * глядящий на доску, не мог прочитать с этой карточки ни фазы по имени, ни ступени словом, ни
 * того, чего от него ждут. Остальные карточки доски названы по-человечески — эта одна говорила
 * на языке запуска, и тем же способом на доску попадала ВСЯКАЯ ступень ВСЯКОЙ фазы.
 *
 * Рядом стояла вторая половина той же беды: ступень, отказавшая за нехватку документа, несла
 * подпись «нет документа — стадия не оставила своего файла». Это правда о ПОСЛЕДСТВИИ и ни
 * слова о том, что человеку с этим делать.
 *
 * ═══════════════ ЧТО ЭТОТ ФАЙЛ УТВЕРЖДАЕТ ═══════════════
 *
 *   (1) ЗАГОЛОВОК СТУПЕНИ НЕ НАЧИНАЕТСЯ СО СЛЭША — ни у одной ступени канона, ни на одной из
 *       дверей, которые ступени ставят. Это и есть жалоба, записанная проверкой.
 *   (2) ЗАГОЛОВОК НАЗЫВАЕТ ТРИ ВЕЩИ: фазу (именем, когда имя известно, иначе номером), ступень
 *       её словом и то, чего ступень ждёт.
 *   (3) КОМАНДА НЕ ИСЧЕЗЛА, А ПЕРЕЕХАЛА ВНУТРЬ КАРТОЧКИ: дверь карточки задачи отдаёт её
 *       отдельным полем, перестроенной из замороженной таблицы, и она НЕ равна заголовку.
 *       Работа, ступенью не являющаяся, не несёт этого поля вовсе.
 *   (4) ОТКАЗ ЗА НЕХВАТКУ ДОКУМЕНТА НАЗЫВАЕТ РЕШЕНИЕ — и доезжает до карточки задачи, где
 *       человек его читает.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: провода «дверь и работник получают одну команду» — он живёт там же, где жил
 * (`front-phase.test.ts`), и этой работой только усилен второй половиной («промпт не равен
 * заголовку»).
 */

import { Readable } from 'node:stream'

import { describe, it, expect } from 'vitest'

import { createFrontServer } from '../src/front/server.mjs'
import { derivePhaseCard } from '../src/front/state.mjs'
import { REASON_LABELS, TASK_STAGES } from '../src/queue/adapter.mjs'
import { stageCommand, STAGE_WORDS, STAGE_AWAITS } from '../src/policy/phase-cycle.mjs'

const TOKEN = 'w'.repeat(64)
const PROJECT = '/proj'
const PHASE = '21'

// ── дерево в памяти: одна фаза с каталогом, названным словами ──

function norm(p: string): string {
  return String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')
}

function fakeFs(initial: Record<string, string>) {
  const files = new Map<string, string>()
  for (const [k, v] of Object.entries(initial)) files.set(norm(k), v)

  const dirSet = () => {
    const dirs = new Set<string>(['/'])
    for (const p of files.keys()) {
      const parts = p.split('/')
      parts.pop()
      let acc = ''
      for (const part of parts) {
        acc = acc === '' ? (part === '' ? '/' : part) : acc === '/' ? `/${part}` : `${acc}/${part}`
        dirs.add(acc)
      }
    }
    return dirs
  }

  return {
    existsSync(p: string) {
      const k = norm(p)
      return files.has(k) || dirSet().has(k)
    },
    readdirSync(p: string) {
      const k = norm(p)
      if (!dirSet().has(k)) throw new Error(`ENOENT: ${k}`)
      const prefix = k === '/' ? '/' : `${k}/`
      const out = new Set<string>()
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue
        const rest = f.slice(prefix.length)
        if (rest === '') continue
        out.add(rest.split('/')[0])
      }
      return [...out].sort()
    },
    readFileSync(p: string) {
      const k = norm(p)
      if (!files.has(k)) throw new Error(`ENOENT: ${k}`)
      return files.get(k) as string
    },
    statSync(p: string) {
      const k = norm(p)
      const isFile = files.has(k)
      if (!isFile && !dirSet().has(k)) throw new Error(`ENOENT: ${k}`)
      return { isDirectory: () => !isFile, isFile: () => isFile }
    },
    mkdirSync() {},
    writeFileSync(p: string, text: string) {
      files.set(norm(p), String(text))
    },
    renameSync(from: string, to: string) {
      const k = norm(from)
      const text = files.get(k)
      files.delete(k)
      if (text !== undefined) files.set(norm(to), text)
    },
    unlinkSync(p: string) {
      files.delete(norm(p))
    },
  }
}

const fixture = () =>
  fakeFs({
    [`${PROJECT}/.planning/phases/${PHASE}-front-polirovka/${PHASE}-CONTEXT.md`]: '# контекст',
  })

// ── ненастоящие req/res, формой как у соседних дверных тестов ──

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', body } = o
  const payload = body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req: any = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = {
    authorization: `Bearer ${TOKEN}`,
    ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
  }
  req.socket = { remoteAddress: '10.0.0.7' }
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

/**
 * ПОДТВЕРЖДЁННЫЙ ЧЕРТЁЖ ЭТОЙ ФАЗЫ — чтобы ворота исполнения пропускали ступень `execute`.
 * Ворота — не предмет этого файла, и обходить их здесь нечем: им дают то, чего они просят.
 */
const APPROVED_DESIGN = {
  id: 'S-1',
  source: 'roster',
  lane: 'paperwork',
  title: 'Фаза 21 · дизайн — чертёж принят',
  status: 'completed',
  enqueuedAt: 100,
  attempt: 1,
  data: { kind: 'document', stage: 'design', phase: PHASE },
}

/** Дверь конвейера фаз с теми же сотрудниками, что у неё в бою. Без карточки — «фаз не видно». */
function mkFront({ blind = false }: { blind?: boolean } = {}) {
  const enqueued: any[] = []
  const io = fixture()
  const front = createFrontServer({
    config: { token: TOKEN },
    deps: {
      repoDir: PROJECT,
      fsImpl: io,
      clock: () => 1770000000000,
      adapter: {
        enqueue: async (t: any) => {
          enqueued.push(t)
          return { id: t.id, coalesced: false }
        },
        list: async () => [APPROVED_DESIGN],
      },
      hub: { emit: () => {} },
      ...(blind ? {} : { derivePhaseCard }),
    },
  })
  return { front, enqueued, io }
}

async function startStage(front: any, stage: string, phase: string = PHASE) {
  const res = mkRes()
  await front.handle(mkReq({ method: 'POST', url: '/api/phase/stage', body: { phase, stage } }), res)
  return res
}

// ═══════════ (1) ЗАГОЛОВОК СТУПЕНИ НЕ НАЧИНАЕТСЯ СО СЛЭША ═════════════════════════════════

describe('заголовок карточки ступени — это предложение, а не командная строка', () => {
  it('ни одна ступень канона не приезжает на доску заголовком со слэша', async () => {
    const { front, enqueued } = mkFront()
    for (const stage of TASK_STAGES) {
      const res = await startStage(front, stage)
      expect(res.statusCode, stage).toBe(200)
    }
    expect(enqueued).toHaveLength(TASK_STAGES.length)
    for (const task of enqueued) {
      expect(String(task.title).startsWith('/'), `${task.data.stage}: ${task.title}`).toBe(false)
      // и это не «почищенная команда»: имени запускающей команды в заголовке нет вовсе
      expect(String(task.title)).not.toContain('--')
      expect(String(task.title)).not.toContain('sma-')
    }
  })

  it('заголовок и команда — разные строки, и команда не прячется внутри заголовка', async () => {
    const { front, enqueued } = mkFront()
    await startStage(front, 'discuss')
    const [task] = enqueued
    const command = stageCommand('discuss', PHASE) as string
    expect(task.title).not.toBe(command)
    expect(String(task.title)).not.toContain(command)
  })
})

// ═══════════ (2) ЗАГОЛОВОК НАЗЫВАЕТ ФАЗУ, СТУПЕНЬ И ОЖИДАНИЕ ══════════════════════════════

describe('заголовок называет фазу, ступень и то, чего она ждёт', () => {
  it('фаза — своим ИМЕНЕМ, тем же, каким её называет карточка фазы', async () => {
    const { front, enqueued, io } = mkFront()
    await startStage(front, 'plan')
    const name = (derivePhaseCard({ projectDir: PROJECT, phaseId: PHASE, fsImpl: io }) as any).name
    expect(String(name).trim()).not.toEqual('')
    expect(enqueued[0].title).toContain(name)
  })

  it('ступень — своим словом, и оно у каждой своё', async () => {
    const { front, enqueued } = mkFront()
    for (const stage of TASK_STAGES) await startStage(front, stage)
    for (const task of enqueued) {
      expect(String(task.title), task.data.stage).toContain(STAGE_WORDS[task.data.stage as keyof typeof STAGE_WORDS])
    }
    expect(new Set(Object.values(STAGE_WORDS)).size).toBe(TASK_STAGES.length)
  })

  it('и говорит, чего ступень ждёт — предложением, а не флагом', async () => {
    const { front, enqueued } = mkFront()
    for (const stage of TASK_STAGES) await startStage(front, stage)
    for (const task of enqueued) {
      expect(String(task.title), task.data.stage).toContain(STAGE_AWAITS[task.data.stage as keyof typeof STAGE_AWAITS])
    }
  })

  it('проекции фаз не подключено — фаза названа НОМЕРОМ, а не пустыми кавычками', async () => {
    const { front, enqueued } = mkFront({ blind: true })
    await startStage(front, 'verify')
    expect(enqueued[0].title).toBe(`Фаза ${PHASE} · ${STAGE_WORDS.verify} — ${STAGE_AWAITS.verify}`)
    expect(String(enqueued[0].title)).not.toContain('««')
  })
})

// ═══════════ (3) КОМАНДА ЕДЕТ СЛЕДОМ ВНУТРИ КАРТОЧКИ ══════════════════════════════════════

/** Карточка одной задачи, как её отдаёт дверь окну. */
async function cardOf(row: any, attempts: any[] = []) {
  const front = createFrontServer({
    config: { token: TOKEN },
    deps: {
      adapter: { list: async () => [row] },
      ledger: {
        readAttempts: () => attempts,
        readAttemptLog: () => ({ entries: [], truncated: false, roles: [], rolesMore: 0, digest: null }),
        readJournalEntries: () => [],
      },
    },
  })
  const res = mkRes()
  await front.handle(mkReq({ url: `/api/task/${row.id}` }), res)
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body)
}

describe('команда ступени не пропала — она лежит следом ВНУТРИ карточки задачи', () => {
  it('карточка ступени несёт ту же команду, что получит работник, и она не заголовок', async () => {
    const { front, enqueued } = mkFront()
    await startStage(front, 'design')
    const row = { ...enqueued[0], status: 'queued' }

    const card = await cardOf(row)
    expect(card.task.command).toBe(stageCommand('design', PHASE))
    expect(card.task.stage).toBe('design')
    expect(card.task.phase).toBe(PHASE)
    // слово ступени карточка читает из заголовка, а не вторым полем рядом
    expect(card.task.title).toContain(STAGE_WORDS.design)
    // след, а не заголовок
    expect(card.task.title).not.toBe(card.task.command)
    expect(String(card.task.title).startsWith('/')).toBe(false)
  })

  it('обычная работа ступенью не является — полей ступени у неё нет вовсе, а не пустые', async () => {
    const card = await cardOf({ id: 'BL-7', status: 'queued', lane: 'prod', title: 'починить окно', attempt: 1 })
    expect('command' in card.task).toBe(false)
    expect('stage' in card.task).toBe(false)
    expect('phase' in card.task).toBe(false)
  })
})

// ═══════════ (4) ОТКАЗ НАЗЫВАЕТ РЕШЕНИЕ, А НЕ ТОЛЬКО ПОСЛЕДСТВИЕ ══════════════════════════

describe('ступень без документа называет человеку его решение', () => {
  it('подпись отказа говорит, ЧТО делать, а не только что случилось', () => {
    const label = String(REASON_LABELS.no_artifact)
    expect(label).toContain('нет документа')
    // …и дальше — два выбора человека, названные глаголами
    expect(label).toMatch(/заново/)
    expect(label).toMatch(/закрыть/)
  })

  it('и эта подпись доезжает до карточки задачи, где человек её читает', async () => {
    const { front, enqueued } = mkFront()
    await startStage(front, 'discuss')
    const row = { ...enqueued[0], status: 'failed', attempt: 1 }

    const card = await cardOf(row, [{ attempt: 1, outcome: 'failed', failureReason: 'no_artifact' }])
    expect(card.attempts[0].reasonLabel).toBe(REASON_LABELS.no_artifact)
    expect(card.attempts[0].reasonLabel).toMatch(/заново/)
  })
})
