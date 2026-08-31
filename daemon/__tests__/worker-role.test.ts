/**
 * worker-role.test.ts — РАБОТНИКИ И АГЕНТЫ: РОЛЬ РЕШАЕТ РАНЬШЕ ПОРЯДКА СТРОК.
 *
 * ЧТО СЛУЧИЛОСЬ 28.08. Владелец открыл доску и увидел `sma-code-fixer` над задачей, к починке
 * кода отношения не имевшей. Разбор показал, что это устройство, а не сбой: маршрутизатор брал
 * `candidates[0]` — первого свободного В ПОРЯДКЕ СТРОК КОНФИГА, — и роль не смотрел вовсе.
 * Значит инлайн-задачи разбирали первые шесть по алфавиту, среди них исследователи на младшей
 * модели. Рукой это лечили выключением тридцати восьми строк из очереди — лекарство, которое
 * держится ровно до следующей правки конфига, и никак не связанное с самой болезнью.
 *
 * СЕМЬ ВОПРОСОВ, ПО ОДНОМУ describe НА КАЖДЫЙ, И ВСЕ СЕМЬ — ПРО УСТРОЙСТВО:
 *
 *   1. КТО ЭТОТ РАБОТНИК ПО РОЛИ — выводится из того, что в конфиге УЖЕ есть (имя описания
 *      агента), а не из второго словаря рядом. Работник без описания — исполнитель, и это не
 *      догадка: `max-1`, `pro-1`, `creator` из поставочного конфига описаний не носят и пишут код.
 *   2. ЗАДАЧА БЕЗ СЛОВА О РОЛИ ЕДЕТ ИСПОЛНИТЕЛЮ — НА ЛЮБОМ МЕСТЕ ПУЛА. Исполнитель ставится в
 *      пул на КАЖДОЕ место по очереди, и выбран он каждый раз. Это тот же приём, каким проверен
 *      отказ верхушке: порядок строк в конфиге не должен решать ничего.
 *   3. СПЕЦИАЛИСТА БЕРУТ ПОИМЁННО — и только так. Названный ролью исследователь работу получает;
 *      он же, никем не названный, не получает её ни при каком порядке и ни при каких окнах.
 *   4. РОЛИ, КОТОРОЙ НЕТ НИ У КОГО, ЕСТЬ СВОЁ СЛОВО. `role_unavailable` — не «нет окна»: чинится
 *      оно человеком, а не ожиданием, поэтому оно И в закрытом словаре диспетчера, И в таксономии
 *      провалов, И среди тех концов, за которыми нет следующей попытки.
 *   5. НАЗВАННОГО СПЕЦИАЛИСТА НЕ ПОДМЕНЯЮТ МОЛЧА. Выключенный, но названный поимённо, отвечает
 *      тем же `role_unavailable`, а не «нет окна» и не платным каналом: определение агента
 *      выдаётся сессии только через выбранного работника, поэтому откат означал бы обычную
 *      сессию под именем исследователя — ту же подмену, за деньги и молча.
 *   6. КОГО МОЖНО НАЗВАТЬ ПРИ ПОСТАНОВКЕ — список, который читает форма. Свёрнут по ролям, счёт
 *      включённых отдельно от общего, верхушки в нём нет, порядок свой, а не конфигов.
 *   7. СТАРОЕ ПОВЕДЕНИЕ НЕ СЛОМАНО. Поставочный конфиг (никаких описаний вовсе) маршрутизируется
 *      ровно как раньше; занятость, окна и деньги остаются своими причинами, а не подменяются
 *      ролью; пустой пул отвечает тем же словом, что и всегда.
 *
 * Ни один случай не поднимает процесс, не ходит в сеть и не читает настоящий ~/.sma-daemon:
 * маршрутизатор чист, часы свои, окна — предикат.
 */

import { describe, it, expect } from 'vitest'

import {
  EXECUTOR_ROLE,
  isExecutor,
  normalizeRole,
  roleFromDefinitionPath,
  roleIsNamed,
  roleOf,
  roleWanted,
} from '../src/policy/worker-role.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { deriveRoles } from '../src/front/state.mjs'
import { AWAITS_A_PERSON, FAIL_REASONS, REASON_LABELS, validateTask } from '../src/queue/adapter.mjs'
import { DISPATCH_REASONS } from '../src/front/journal.mjs'

/** Ночь: дневная защита счёта владельца выключена, поэтому единственная причина отказа — роль. */
const nightClock = () => new Date(2026, 7, 28, 2, 0, 0).getTime()

const account = (name: string) => ({ name, configDir: `C:\\accounts\\${name}` })

/** Специалист — тот, у кого есть СВОЁ описание агента. */
const specialist = (id: string) => ({
  id,
  lane: 'prod',
  provider: 'claude',
  account: account('local-1'),
  roleFile: `.claude/agents/${id}.md`,
  model: 'sonnet',
})

/** Исполнитель — шесть копий одного описания, ровно как их завёл владелец 28.08. */
const executor = (id: string) => ({
  id,
  lane: 'prod',
  provider: 'claude',
  account: account('local-1'),
  roleFile: '.claude/agents/sma-executor.md',
  model: 'opus',
})

/** Пул в том виде, в каком он и оказался опасным: специалисты стоят по алфавиту ПЕРЕД исполнителями. */
const POOL = [
  specialist('sma-advisor-researcher'),
  specialist('sma-ai-researcher'),
  specialist('sma-assumptions-analyzer'),
  specialist('sma-code-fixer'),
  specialist('sma-code-reviewer'),
  executor('sma-executor'),
  executor('sma-executor-2'),
]

const deps = { workers: POOL, windows: () => true, clock: nightClock, config: {} }

const task = (extra: Record<string, unknown> = {}) => ({ id: 'R-1', source: 'roster', title: 'работа', lane: 'prod', attempt: 1, ...extra })

describe('кто этот работник по роли — выводится из того, что в конфиге уже есть', () => {
  it('работник без описания агента — исполнитель, и это не догадка', () => {
    // Поставочный конфиг: `max-1`, `pro-1`, `creator` описаний не носят и всегда писали код.
    expect(roleOf({ id: 'max-1' })).toBe(EXECUTOR_ROLE)
    expect(isExecutor({ id: 'creator' })).toBe(true)
  })

  it('роль — это имя описания агента, тем же именем его зовёт и рой', () => {
    expect(roleOf(specialist('sma-ai-researcher'))).toBe('ai-researcher')
    expect(roleOf(executor('sma-executor-4'))).toBe(EXECUTOR_ROLE)
  })

  it('путь читается и через косую, и через обратную — конфиг пишут на обеих системах', () => {
    expect(roleFromDefinitionPath('.claude/agents/sma-code-fixer.md')).toBe('code-fixer')
    expect(roleFromDefinitionPath(String.raw`.claude\agents\sma-code-fixer.md`)).toBe('code-fixer')
  })

  it('рука человека главнее выведенного: поле role перебивает описание', () => {
    expect(roleOf({ id: 'x', role: 'planner', roleFile: '.claude/agents/sma-executor.md' })).toBe('planner')
  })

  it('одна нормализация на обе стороны сравнения — «sma-executor» и «executor» это одна роль', () => {
    expect(normalizeRole('sma-ai-researcher')).toBe(normalizeRole('AI-Researcher'))
    expect(roleWanted({ role: 'sma-ai-researcher' })).toBe(roleWanted({ role: 'ai-researcher' }))
  })

  it('задача, не сказавшая о роли, просит ИСПОЛНИТЕЛЯ, а не «кого угодно»', () => {
    expect(roleWanted({ lane: 'prod' })).toBe(EXECUTOR_ROLE)
    expect(roleWanted(undefined)).toBe(EXECUTOR_ROLE)
  })
})

describe('задача без слова о роли едет исполнителю — на любом месте пула', () => {
  it('первый по алфавиту специалист работу НЕ получает', () => {
    const route = resolveRoute(task(), deps)
    expect(route.workerId).not.toBe('sma-advisor-researcher')
    expect(route.workerId).toBe('sma-executor')
  })

  it('вставленный на КАЖДОЕ место пула, исполнитель выбран каждый раз', () => {
    // Порядок строк в конфиге не должен решать ничего — тот же приём, каким проверен отказ
    // верхушке. Без фильтра роли этот случай красный на всех местах, кроме нулевого.
    const others = POOL.filter((w) => !isExecutor(w))
    for (let seat = 0; seat <= others.length; seat += 1) {
      const workers = [...others.slice(0, seat), executor('sma-executor'), ...others.slice(seat)]
      const route = resolveRoute(task(), { ...deps, workers })
      expect(route.workerId, `исполнитель стоял на месте ${seat}`).toBe('sma-executor')
    }
  })

  it('он не получает её и тогда, когда окно открыто ТОЛЬКО у специалиста', () => {
    // Участие специалиста не должно зависеть от того, чьё окно сейчас открыто: это и есть
    // «случай», который фильтр роли лечит.
    const route = resolveRoute(task(), { ...deps, windows: (w: { id: string }) => w.id === 'sma-code-fixer' })
    expect(route.workerId).toBeNull()
    expect(route.reasonCode).toBe('window_exhausted')
  })
})

describe('специалиста берут поимённо — и только так', () => {
  it('названный ролью исследователь работу получает', () => {
    const route = resolveRoute(task({ id: 'R-2', role: 'sma-ai-researcher' }), deps)
    expect(route.workerId).toBe('sma-ai-researcher')
  })

  it('названа роль — соседи по алфавиту не подходят даже стоя первыми', () => {
    const route = resolveRoute(task({ id: 'R-3', role: 'code-reviewer' }), deps)
    expect(route.workerId).toBe('sma-code-reviewer')
  })

  it('роль доезжает до строки очереди, а роль-путь дверь отвергает', () => {
    expect(validateTask({ id: 'T', source: 'roster', title: 't', lane: 'prod', role: 'ai-researcher' }).role).toBe('ai-researcher')
    expect(() => validateTask({ id: 'T', source: 'roster', title: 't', lane: 'prod', role: '../etc/passwd' })).toThrow()
  })

  it('не названа — не выдумывается: строка честно молчит о роли', () => {
    expect(validateTask({ id: 'T', source: 'roster', title: 't', lane: 'prod' }).role).toBeUndefined()
  })

  it('верхушку нельзя вызвать по роли — она не исполнитель ни при какой', () => {
    const workers = [{ id: 'orchestrator', role: 'orchestrator', provider: 'claude', account: account('o') }]
    const route = resolveRoute(task({ id: 'R-4', role: 'orchestrator' }), { ...deps, workers })
    expect(route.workerId).toBeNull()
  })
})

describe('роли, которой нет ни у кого, есть своё слово', () => {
  it('маршрут отвечает role_unavailable, а не «нет окна»', () => {
    const route = resolveRoute(task({ id: 'R-5', role: 'debugger' }), deps)
    expect(route.workerId).toBeNull()
    expect(route.reasonCode).toBe('role_unavailable')
  })

  it('слово есть во ВСЕХ трёх словарях — иначе тик умрёт от собственной правды', () => {
    // `fail()` бросает на слове, которого нет в таксономии, а журнал молча роняет код, которого
    // нет в закрытом словаре: половина провода тут не работает как половина, она работает как
    // тишина.
    expect(Object.prototype.hasOwnProperty.call(DISPATCH_REASONS, 'role_unavailable')).toBe(true)
    expect(FAIL_REASONS).toContain('role_unavailable')
    expect(typeof REASON_LABELS.role_unavailable).toBe('string')
  })

  it('и оно ЖДЁТ ЧЕЛОВЕКА: повтор дал бы тот же ответ, потратив оплаченную попытку', () => {
    expect(AWAITS_A_PERSON).toContain('role_unavailable')
  })

  it('у каждой причины провала есть подпись — новое слово не приезжает немым', () => {
    const unlabelled = FAIL_REASONS.filter((r: string) => typeof REASON_LABELS[r] !== 'string')
    expect(unlabelled).toEqual([])
  })
})

describe('названного специалиста не подменяют молча', () => {
  // Ровно состав 28.08 после лечения рукой: специалисты выключены из очереди, исполнители нет.
  const offline = { ...specialist('sma-ai-researcher'), enabled: false }
  const pool = [offline, executor('sma-executor')]
  /** Деньги разрешают откат: без этого шва проверка «не ушло в платный канал» ничего не значит. */
  const budget = () => ({ fallback: true })

  it('выключенный, но названный поимённо, — это role_unavailable, а не «нет окна»', () => {
    const route = resolveRoute(task({ id: 'R-13', role: 'ai-researcher' }), { ...deps, workers: pool, budget })
    expect(route.workerId).toBeNull()
    expect(route.reasonCode).toBe('role_unavailable')
  })

  it('и НЕ платный канал: он роли не несёт, и подмена прошла бы за деньги и молча', () => {
    // Определение агента выдаётся сессии только через выбранного работника (loop.mjs). Откат
    // на платный канал означал бы обычную сессию под именем исследователя — та же болезнь,
    // ради которой заведена задача, только с другого конца.
    const route = resolveRoute(task({ id: 'R-14', role: 'ai-researcher' }), { ...deps, workers: pool, budget })
    expect(route.useApiFallback).toBe(false)
  })

  it('слова различают «нет такого» и «выключен» — действия человека тут разные', () => {
    const off = resolveRoute(task({ id: 'R-15', role: 'ai-researcher' }), { ...deps, workers: pool })
    const none = resolveRoute(task({ id: 'R-16', role: 'debugger' }), { ...deps, workers: pool })
    expect(off.reason).toContain('выключен')
    expect(none.reason).not.toContain('выключен')
  })

  it('безымянная работа старого поведения не теряет: выключенный пул отвечает как всегда', () => {
    // Асимметрия намеренная. Машина, у которой выключены все работники, никого не называла —
    // и получает то же, что получала всегда: закрытые окна и правило денег.
    const allOff = pool.map((w) => ({ ...w, enabled: false }))
    const route = resolveRoute(task({ id: 'R-17' }), { ...deps, workers: allOff, budget })
    expect(route.reasonCode).not.toBe('role_unavailable')
    expect(route.useApiFallback).toBe(true)
  })

  it('«названа ли роль» — вопрос отдельный от «кого просит работа»', () => {
    expect(roleIsNamed(task())).toBe(false)
    expect(roleIsNamed(task({ role: 'ai-researcher' }))).toBe(true)
    expect(roleIsNamed(task({ role: '   ' }))).toBe(false)
  })
})

describe('кого можно назвать при постановке — список ролей для формы', () => {
  it('исполнитель первым, специалисты по алфавиту: порядок строк конфига тут не решает', () => {
    const roles = deriveRoles({ workers: POOL })
    expect(roles[0].role).toBe(EXECUTOR_ROLE)
    expect(roles.map((r) => r.role)).toEqual([
      EXECUTOR_ROLE,
      'advisor-researcher',
      'ai-researcher',
      'assumptions-analyzer',
      'code-fixer',
      'code-reviewer',
    ])
  })

  it('выключенные посчитаны, но готовыми не притворяются', () => {
    const roles = deriveRoles({ workers: [{ ...specialist('sma-ai-researcher'), enabled: false }, executor('sma-executor')] })
    const researcher = roles.find((r) => r.role === 'ai-researcher')
    expect(researcher).toMatchObject({ ready: 0, total: 1, executor: false })
    expect(roles.find((r) => r.role === EXECUTOR_ROLE)).toMatchObject({ ready: 1, total: 1, executor: true })
  })

  it('имя, под которым человек видит его в окне, едет вместе с ролью', () => {
    // На «Агентах» он подписан `sma-ai-researcher`; форма обязана называть его так же, иначе
    // человек выбирает не того, кого узнал.
    expect(deriveRoles({ workers: POOL }).find((r) => r.role === 'ai-researcher')?.title).toBe('sma-ai-researcher')
  })

  it('верхушку предложить нельзя — она не берёт инлайн-задач ни при какой роли', () => {
    const roles = deriveRoles({ workers: [{ id: 'orchestrator', role: 'orchestrator', provider: 'claude' }, executor('sma-executor')] })
    expect(roles.map((r) => r.role)).toEqual([EXECUTOR_ROLE])
  })

  it('машина без работников отвечает пустым списком, а не отсутствием списка', () => {
    expect(deriveRoles({})).toEqual([])
  })
})

describe('старое поведение не сломано', () => {
  const stock = [
    { id: 'max-1', lane: 'prod', provider: 'claude', account: account('max-1') },
    { id: 'pro-1', lane: 'research', provider: 'codex', account: account('pro-1') },
  ]

  it('поставочный конфиг маршрутизируется ровно как раньше', () => {
    expect(resolveRoute(task({ id: 'R-6' }), { ...deps, workers: stock }).workerId).toBe('max-1')
    expect(resolveRoute(task({ id: 'R-7', lane: 'research' }), { ...deps, workers: stock }).workerId).toBe('pro-1')
  })

  it('занятость остаётся своей причиной, а не подменой специалистом', () => {
    // Именно это подменялось раньше: свободный специалист забирал работу, потому что стоял
    // выше по списку. Теперь занятые исполнители — это `worker_busy`, и задача ждёт их.
    const busy = new Set(['sma-executor', 'sma-executor-2'])
    const route = resolveRoute(task({ id: 'R-8' }), { ...deps, busyWorkers: busy })
    expect(route.workerId).toBeNull()
    expect(route.reasonCode).toBe('worker_busy')
  })

  it('проба пригодности полосы по роли находит свободного специалиста, когда исполнители заняты', () => {
    // ЭТО ПРО ЗАХВАТ, А НЕ ПРО МАРШРУТ. Пригодность полосы решается ДО того, как кто-либо
    // посмотрел на строку, поэтому одна безролевая проба спрашивала бы только «свободен ли
    // исполнитель» — и работа, названная специалистом поимённо, не была бы захвачена вовсе,
    // молча, ровно в ту минуту, когда исполнители заняты, а названный свободен. Тик пробует
    // КАЖДУЮ роль пула (см. eligibleLanes); здесь проверено то, на что он при этом опирается.
    const busy = new Set(['sma-executor', 'sma-executor-2'])
    expect(resolveRoute(task({ id: 'R-11' }), { ...deps, busyWorkers: busy }).workerId).toBeNull()
    expect(resolveRoute(task({ id: 'R-12', role: 'ai-researcher' }), { ...deps, busyWorkers: busy }).workerId).toBe(
      'sma-ai-researcher',
    )
  })

  it('пустой пул отвечает прежним словом — общая пустота не есть отсутствие роли', () => {
    const route = resolveRoute(task({ id: 'R-9' }), { ...deps, workers: [] })
    expect(route.reasonCode).toBe('window_exhausted')
  })

  it('маршрут по-прежнему объясняет себя — и теперь называет роль выбранного', () => {
    const written: Record<string, unknown>[] = []
    const route = resolveRoute(task({ id: 'R-10' }), { ...deps, decisionJournal: (e: Record<string, unknown>) => written.push(e) })
    expect(route.workerId).toBe('sma-executor')
    expect(written).toHaveLength(1)
    const payload = written[0].payload as { code: string; workerId: string; role: string }
    expect(payload.workerId).toBe('sma-executor')
    expect(payload.role).toBe(EXECUTOR_ROLE)
  })
})
