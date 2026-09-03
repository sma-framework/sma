import { useMemo, useState } from 'react'
import { useStateQuery } from '../../api/queries'
import type { OrchestratorRow, Presence, WorkerRow } from '../../api/types'
import { OPEN_SCREEN_EVENT } from '../../shell/navigation'
import type { OpenScreenDetail } from '../../shell/navigation'
import { WorkerCard } from './WorkerCard'
import { WorkerHistory } from './WorkerHistory'

/**
 * «Команда» — the roster: who is on what, whose window is nearly spent, who is free.
 *
 * The screen RENDERS presence, it does not work it out. `workers[].presence` arrives from
 * the daemon already decided, and the three words it can be are printed exactly as they
 * came. That is the whole doctrine of this screen in one line: derive on one side of the
 * wire, render on the other. A roster that recomputed «who is busy» from the window and the
 * task in hand would be a second opinion, and two opinions about a worker is how a person
 * stops believing either.
 *
 * Everything else on the screen comes out of the SAME one reading, and NOTHING here asks the
 * daemon a question of its own: the task in hand is a row the window already holds, and the two
 * figures under a worker's name arrive counted — `workers[].stats30d`, «сделано / не получилось»
 * over the last 30 days, measured by the daemon out of the attempt ledger.
 *
 * И ВЕРХУШКА ЗДЕСЬ ЖЕ, НО НЕ В ОДНОМ РЯДУ. Оркестратор приезжает своим ключом состояния и
 * рисуется полосой НАД сеткой исполнителей: он задач не берёт, поэтому у него нет ни полосы
 * работы, ни окна, ни счёта сделанного, и карточка работника с пустыми полями сказала бы о нём
 * неправду. Счётчики в шапке считают по-прежнему только исполнителей — «работают / ждут окно /
 * свободны» это слова про тех, кто берёт задачи.
 *
 * They used to be tallied HERE, by walking `data.done` — the finished rows the reading happened
 * to still be carrying. That list is capped and it is about «сделано за ночь», so the numbers
 * moved when the list moved and a worker whose work had scrolled out of it read as one who had
 * done nothing. A statistic is a count over a stated period, not over whatever a poll returned;
 * the period now rides in the payload and the screen only prints it, with «за 30 дней» said in
 * words beside the figures.
 *
 * РАБОТНИКИ И АГЕНТЫ — ЭТО РАЗНОЕ, И ЭКРАН НАКОНЕЦ ЭТО ГОВОРИТ. Раньше здесь была одна сетка на
 * сорок пять карточек, и над ней было написано «Команда»: включённый исследователь выглядел
 * ровно как включённый исполнитель, хотя работу они берут по-разному. Теперь их две, и разница
 * названа словами:
 *   • РАБОТНИКИ — исполнители. Они разбирают очередь: инлайн-задачи и куски сборок. Счётчики в
 *     шапке считают ТОЛЬКО их, потому что «работают / ждут окно / свободны» — это слова про тех,
 *     кто берёт задачи.
 *   • АГЕНТЫ — специалисты. Их поднимает фаза внутри своей работы, и на инлайн-задачу их зовут
 *     ПОИМЁННО. Сами по себе они из очереди не берут ничего — ни при каком порядке строк.
 * Признак приезжает СЧИТАННЫМ (`workers[].inQueue`, `workers[].role`): экран, решающий это сам,
 * стал бы вторым мнением о том, кого выберет маршрутизатор.
 *
 * И РАБОТНИК ТЕПЕРЬ ОТКРЫВАЕТСЯ. По имени (и по самим цифрам) открывается его история —
 * `workers[].history`, работы, которые он вёл, с исходом каждой и с переходом в карточку
 * любой из них. Она приезжает тем же одним чтением и из того же прохода по леджеру, что и
 * цифры: экран по-прежнему НИЧЕГО не спрашивает у демона от себя и ничего не считает сам.
 */

/** The lines of work, in the words the rest of the product uses for them. */
const LANE_LABEL: Record<string, string> = {
  prod: 'прод-код',
  research: 'ресёрч',
  paperwork: 'бумага',
  forge: 'кузница',
}

/**
 * The path a task walks: the lines of work that are actually STAFFED, in the order the work
 * moves through them, and the person it ends at. A line nobody sits on is not drawn — the
 * strip says who is here, not who was imagined.
 */
const LANE_ORDER: readonly string[] = ['research', 'prod', 'paperwork', 'forge'] as const

/** The three words, and the order they are counted in above the roster. */
const PRESENCE_COUNTS: readonly { presence: Presence; label: string; tone: string }[] = [
  { presence: 'работает', label: 'работают', tone: 'text-green' },
  { presence: 'ждёт окно', label: 'ждут окно', tone: 'text-warn' },
  { presence: 'свободен', label: 'свободны', tone: 'text-tx2' },
] as const

/**
 * ВЕРХУШКА — СВОЕЙ ПОЛОСОЙ, НАД ИСПОЛНИТЕЛЯМИ И НЕ ПОХОЖЕЙ НА НИХ.
 *
 * Она не карточка работника с пустыми полями: у оркестратора нет ни полосы, ни окна, ни
 * «сделано за 30 дней», потому что всё это — свойства того, кто берёт задачи. Рисовать его
 * такой же карточкой значило бы поставить его в один ряд с исполнителями, а вопрос владельца
 * («а это кто такой») ровно из этого и вырос.
 *
 * Полоса говорит три вещи и ни одной лишней: кто он, что задач не берёт и разговор ведёт он, и
 * какие решения остаются человеку — поимённо, теми же словами, что едут в промпт разговора.
 */
function OrchestratorBand({ orchestrator }: { orchestrator: OrchestratorRow }) {
  return (
    <section className="flex flex-none flex-col gap-2.5 border-b border-bd bg-card px-7 py-4">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="rounded-[7px] border border-teal/40 bg-blue-s px-2 py-0.5 text-[10.5px] font-semibold whitespace-nowrap text-teal">
          Верхушка
        </span>
        <h2 className="m-0 text-[14px] font-semibold text-tx">{orchestrator.name}</h2>
        <span className="text-[12px] text-tx2">{orchestrator.title}</span>
      </div>
      <div className="text-[11.5px] text-tx2">
        Задач из очереди не берёт и за места с исполнителями не соревнуется. Разговор в окне ведёт он.
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] text-tx3">
        <span>Решаете Вы, не он:</span>
        {orchestrator.hardCalls.map((c) => (
          <span
            key={c.id}
            title={c.words}
            className="rounded-[7px] border border-bd px-1.5 py-0.5 whitespace-nowrap text-tx2"
          >
            {c.label}
          </span>
        ))}
      </div>
      {orchestrator.account ? (
        <div className="text-[10.5px] text-tx3">говорит через {orchestrator.account}</div>
      ) : (
        <div className="text-[10.5px] text-tx3">говорить нечем: аккаунта на этой машине нет</div>
      )}
    </section>
  )
}

function KpiPill({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
      <span className={`text-[16px] font-bold tabular-nums ${tone}`}>{value}</span>
      <span className="text-[11.5px] text-tx2">{label}</span>
    </div>
  )
}

/**
 * МЕСТА ОДНОВРЕМЕННОЙ РАБОТЫ — «занято X из N», словами, на экране, где человек управляет флотом.
 *
 * ЗАЧЕМ ЭТО ЗДЕСЬ. Потолок мест — настройка, действие которой снаружи не было видно ничем: доска
 * показывала занятых работников, но нигде не было сказано, сколько мест ВСЕГО и сколько из них
 * свободно. Ошибка в этой настройке поэтому и прожила целый день — её нечем было уличить: место
 * молча не выдавалось, задача молча не бралась, и всё это выглядело как «почему-то не едет».
 *
 * ОБА ЧИСЛА ПРИЕЗЖАЮТ СЧИТАННЫМИ. Экран их не выводит: занятые места считает тот, кто их
 * раздаёт, потолок читается там же, где его читает тик. Пересчитать занятость по карточкам
 * работников было бы вторым мнением о том же — а два мнения об одном числе означают, что однажды
 * человек перестанет верить обоим.
 *
 * НЕЧЕМ СКАЗАТЬ — НЕ ГОВОРИМ. `seatsBusy === null` (демон без дома идущих попыток) не рисует
 * ничего: ноль здесь прочитался бы как «все места свободны», то есть как измерение.
 *
 * И РАСХОЖДЕНИЕ СО СПИСКОМ РАБОТНИКОВ НАЗЫВАЕТСЯ ЗДЕСЬ ЖЕ, РЯДОМ С ЧИСЛОМ. «Занято 4 из 4» над
 * списком, в котором работают двое, человек читает как ошибку экрана — и идёт чинить экран
 * вместо аварии. Она была не в экране: за лишними местами шли живые сессии, не привязанные ни к
 * одной карточке, и одна из них проработала час невидимой. Число считает демон одним выражением
 * над теми же карточками, которые нарисованы ниже, — экран его только произносит.
 */
function SeatsPill({ busy, total, unlisted }: { busy: number | null; total: number; unlisted: number | null }) {
  if (busy === null || !Number.isFinite(total)) return null
  const full = busy >= total
  const hidden = typeof unlisted === 'number' && unlisted > 0
  const loud = full || hidden

  return (
    <div
      className={`flex flex-none items-baseline gap-2 rounded-[9px] border px-3.5 py-1.5 shadow-panel ${
        loud ? 'border-warn-s bg-warn-s' : 'border-bd bg-card'
      }`}
      title={
        hidden
          ? 'Столько идущих попыток не показывает ни одна карточка ниже. Такая попытка занимает место, но за ней не стоит работник в списке — её видно на карточке задачи, и остановить её можно там.'
          : 'Сколько задач демон ведёт одновременно. Пока все места заняты, следующая задача ждёт.'
      }
    >
      <span className={`text-[13px] font-semibold tabular-nums ${loud ? 'text-warn-tx' : 'text-tx'}`}>
        {`занято ${busy} из ${total}`}
      </span>
      <span className="text-[11.5px] text-tx2">
        {hidden ? `мест · ${unlisted} вне списка работников` : full ? 'мест — новые задачи ждут' : 'мест'}
      </span>
    </div>
  )
}

function PathStrip({ workers }: { workers: WorkerRow[] }) {
  const staffed = LANE_ORDER.filter((lane) => workers.some((w) => w.lane === lane))
  if (staffed.length === 0) return null
  const steps = [...staffed.map((lane) => LANE_LABEL[lane]), 'Вы']

  return (
    <div className="flex flex-none flex-wrap items-center gap-2.5 border-b border-bd px-7 py-3">
      <span className="text-[11px] whitespace-nowrap text-tx3">Путь задачи:</span>
      {steps.map((step, i) => {
        const last = i === steps.length - 1
        return (
          <div key={step} className="flex items-center gap-2.5">
            <div className="flex items-center gap-[7px]">
              <span aria-hidden className={`h-1.5 w-1.5 flex-none rounded-full ${last ? 'bg-tx' : 'bg-teal'}`} />
              <span
                className={`text-[12.5px] whitespace-nowrap ${last ? 'font-semibold text-tx' : 'text-tx2'}`}
              >
                {step}
              </span>
            </div>
            {last ? null : (
              <span aria-hidden className="text-[12px] text-tx3">
                →
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Одна сетка карточек под своим заголовком и своим объяснением.
 *
 * Заголовок и строка под ним — это и есть разведение понятий: две одинаковые сетки без слов
 * между ними были бы тем же одним списком, только с промежутком.
 */
function RosterSection({
  title,
  explain,
  workers,
  laneLabel,
  titleOf,
  onOpenTask,
  onOpenHistory,
}: {
  title: string
  explain: string
  workers: WorkerRow[]
  laneLabel: (lane: string | null) => string | null
  titleOf: Map<string, string>
  onOpenTask: (taskId: string) => void
  onOpenHistory: (id: string) => void
}) {
  if (workers.length === 0) return null

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2.5">
        <h2 className="m-0 text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">{title}</h2>
        <span className="text-[11px] text-tx3">{workers.length}</span>
      </div>
      <div className="mb-3.5 text-[11.5px] leading-[1.6] text-tx3">{explain}</div>
      {/*
        ЧИСЛО ЗДЕСЬ — ШИРИНА КАРТОЧКИ, А НЕ ШИРИНА РОСПИСИ. Раньше стояло «четыре столбца и пол
        в 1160 px»: пол считался от стола пошире, а рама окна обещает только свой минимум, и в
        остаток за боковой колонкой и полями он не помещался. На самой узкой ширине, при которой
        широкая рама вообще показывается, роспись уезжала вбок внутри своей прокрутки — четвёртый
        работник читался перетаскиванием.

        Столбцы теперь считает сетка: объявлено, сколько нужно ОДНОЙ карточке, а сколько их
        встанет в ряд, решает доступная ширина. Второго числа про окно не появилось, и пол,
        который больше комнаты, взяться неоткуда — ровно та же мина, что когда-то унесла вбок
        экран первого запуска.
      */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(272px,1fr))] gap-[18px]">
        {workers.map((w) => (
          <WorkerCard
            key={w.id}
            worker={w}
            laneLabel={laneLabel(w.lane)}
            taskTitle={w.taskId ? (w.taskTitle ?? titleOf.get(w.taskId) ?? null) : null}
            stats={w.stats30d ?? null}
            onOpenTask={onOpenTask}
            onOpenHistory={() => onOpenHistory(w.id)}
          />
        ))}
      </div>
    </div>
  )
}

export function Screen() {
  const state = useStateQuery()
  const data = state.data
  const workers = data?.workers ?? []
  /**
   * ДВА СПИСКА ИЗ ОДНОГО ЧТЕНИЯ. Делит их признак, приехавший считанным, а не догадка экрана:
   * `inQueue` — «исполнитель, включён, не верхушка», ровно то, что спрашивает маршрутизатор.
   * Выключенный исполнитель попадает к агентам не по недосмотру: очередь его не раздаёт, и
   * стоять он должен там, где стоят все, кого сейчас не выберут.
   */
  const queueWorkers = useMemo(() => workers.filter((w) => w.inQueue), [workers])
  const swarmAgents = useMemo(() => workers.filter((w) => !w.inQueue), [workers])
  /**
   * Открытая история — ПО ИМЕНИ работника, а не копией строки: чтение обновляется каждые
   * несколько секунд, и окно, держащее снимок, показывало бы вчерашнее, пока его не закроют.
   */
  const [openedId, setOpenedId] = useState<string | null>(null)
  const opened = workers.find((w) => w.id === openedId) ?? null

  /**
   * The title of a task in hand.
   *
   * IT COMES OFF THE WORKER'S OWN ROW FIRST, and that is the whole of this fix. The roster is
   * the ONE list that names a claimed task, so the daemon puts that task's name on the worker
   * (`taskTitle`) precisely because no other list carries it: `queue[]` holds rows waiting for
   * a worker, and a task in somebody's hands has left it. The screen looked the name up THERE
   * anyway, missed every time, and printed the routing id where a title belongs — a field
   * computed, delivered and read by nobody, which is the same half-done shape as a number that
   * never reaches the eye.
   *
   * The lookup stays as the fallback for a reading older than that field.
   */
  const titleOf = useMemo(() => {
    const byId = new Map<string, string>()
    for (const row of data?.queue ?? []) byId.set(row.id, row.title ?? 'Без названия')
    return byId
  }, [data])

  const openTask = (taskId: string) => {
    const detail: OpenScreenDetail = { screen: 'task-card', taskId }
    window.dispatchEvent(new CustomEvent<OpenScreenDetail>(OPEN_SCREEN_EVENT, { detail }))
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-2.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 mr-2 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">Команда</h1>
        {/*
          СЧЁТ ИДЁТ ПО ТЕМ, КТО БЕРЁТ ЗАДАЧИ. «Работают / ждут окно / свободны» — слова про пул
          очереди; посчитанные по всем сорока пяти строкам, они говорили «свободны 38» о тех,
          кому очередь всё равно ничего не даст.
        */}
        {PRESENCE_COUNTS.map((p) => (
          <KpiPill
            key={p.presence}
            value={queueWorkers.filter((w) => w.presence === p.presence).length}
            label={p.label}
            tone={p.tone}
          />
        ))}
        <SeatsPill
          busy={data?.kpis?.seatsBusy ?? null}
          total={data?.kpis?.seatsTotal ?? Number.NaN}
          unlisted={data?.kpis?.seatsUnlisted ?? null}
        />
      </header>

      {state.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">
            Связь потеряна. Кто чем занят — на момент последнего, что было видно.
          </span>
        </div>
      ) : null}

      {data?.orchestrator ? <OrchestratorBand orchestrator={data.orchestrator} /> : null}

      {/* Путь задачи — по тем полосам, на которых сидит КТО-ТО ИЗ ПУЛА: полоса, укомплектованная
          одними выключенными специалистами, задачу не проведёт, и рисовать её как ступень пути
          значило бы обещать шаг, которого не будет. */}
      <PathStrip workers={queueWorkers} />

      {workers.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-7">
          <p className="m-0 text-[13px] text-tx2">
            Работников пока нет. Они заводятся на «Агентах» — там же и настраиваются.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-7">
          <div className="flex flex-col gap-[30px]">
            <RosterSection
              title="Работники"
              explain="Исполнители: они разбирают очередь — инлайн-задачи и куски сборок, пишут код и исправляют баги. Задача, о роли которой Вы ничего не сказали, едет одному из них."
              workers={queueWorkers}
              laneLabel={(lane) => (lane ? (LANE_LABEL[lane] ?? lane) : null)}
              titleOf={titleOf}
              onOpenTask={openTask}
              onOpenHistory={setOpenedId}
            />
            <RosterSection
              title="Агенты"
              explain="Специалисты роя: их поднимает фаза внутри своей работы. Из очереди сами они не берут ничего — чтобы отдать инлайн-задачу такому, назовите его роль при постановке."
              workers={swarmAgents}
              laneLabel={(lane) => (lane ? (LANE_LABEL[lane] ?? lane) : null)}
              titleOf={titleOf}
              onOpenTask={openTask}
              onOpenHistory={setOpenedId}
            />
          </div>
        </div>
      )}

      {opened ? (
        <WorkerHistory
          worker={opened}
          stats={opened.stats30d ?? null}
          onOpenTask={(taskId) => {
            setOpenedId(null)
            openTask(taskId)
          }}
          onClose={() => setOpenedId(null)}
        />
      ) : null}
    </section>
  )
}
