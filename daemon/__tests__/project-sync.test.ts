/**
 * Tests for the connected project's watcher + read model (phase 11 plan 09, Task 1;
 * SB-031 part 2, ROADMAP addition 8).
 *
 * WHY THIS FILE IS ENTIRELY INJECTED. The module under test is the daemon's first and only
 * file watcher, and the assumption it runs under (RESEARCH A1: node's native recursive watch
 * is enough) is exactly the kind of thing that behaves differently per platform. So nothing
 * here touches a real watcher, a real clock, a real timer or a real disk: the watch
 * implementation, the one-shot debounce scheduler, the repeating reconcile scheduler and the
 * whole fs are handed in. A test that slept would be a test that flakes on a loaded machine,
 * and this plan's own carry-forward names a watcher test as exactly where that goes wrong.
 *
 * The load-bearing claims:
 *   - a burst of ten filesystem events inside the debounce window is ONE hint, not ten;
 *   - the periodic reconcile emits when the surface digest moved with NO watch event at all
 *     (the dropped-event insurance), and emits NOTHING when it did not (a heartbeat that
 *     always fires teaches the screen to ignore it);
 *   - a hint frame is a doorbell: {event, projectId} and never a file name;
 *   - a watch implementation that throws degrades to reconcile-only and says so ONCE —
 *     a silent downgrade to nothing is the failure the design exists to prevent;
 *   - a missing project directory is a handle that emits nothing and does not throw;
 *   - the module holds NO copy: a read after an edit reflects the edit with no invalidation;
 *   - the read model is a SURFACE — counts, tags and pointers, no body, no absolute path.
 */

import { describe, it, expect } from 'vitest'
import { join } from 'node:path'

import { watchProject, stopWatch, readProjectMemory } from '../src/front/project-sync.mjs'

// ── the fake disk: a map of directory → {filename: text}, with injectable mtimes ──

type Tree = Record<string, Record<string, string>>

function fakeFs(tree: Tree, mtimes: Record<string, number> = {}) {
  const enoent = (p: string) => {
    const e: any = new Error(`ENOENT: no such file or directory, ${p}`)
    e.code = 'ENOENT'
    return e
  }
  const find = (path: string): { text: string } | null => {
    for (const dir of Object.keys(tree)) {
      for (const name of Object.keys(tree[dir])) {
        if (join(dir, name) === path) return { text: tree[dir][name] }
      }
    }
    return null
  }
  return {
    readdirSync(dir: string) {
      const d = tree[dir]
      if (!d) throw enoent(dir)
      return Object.keys(d)
    },
    readFileSync(path: string) {
      const hit = find(path)
      if (!hit) throw enoent(path)
      return hit.text
    },
    statSync(path: string) {
      const hit = find(path)
      if (!hit) throw enoent(path)
      return { size: hit.text.length, mtimeMs: mtimes[path] ?? 1000, isFile: () => true }
    },
  }
}

// ── the fake watcher: the listener is captured so the test fires events synchronously ──

function fakeWatch(opts: { throws?: boolean } = {}) {
  const listeners: Array<(ev: string, name: string) => void> = []
  const errorHandlers: Array<(err: unknown) => void> = []
  const watched: string[] = []
  const closed: string[] = []
  const impl = (path: string, _o: unknown, listener: (ev: string, name: string) => void) => {
    if (opts.throws) throw new Error('watch is not supported on this platform')
    watched.push(path)
    listeners.push(listener)
    return {
      close: () => closed.push(path),
      on: (evt: string, fn: (err: unknown) => void) => {
        if (evt === 'error') errorHandlers.push(fn)
      },
    }
  }
  return {
    impl,
    watched,
    closed,
    errorHandlers,
    /** fire n filesystem events at the first established watcher */
    fire(n = 1) {
      for (let i = 0; i < n; i += 1) listeners[0]('change', 'a-note.md')
    },
  }
}

// ── the fake schedulers: no wall clock anywhere, the test runs the callbacks itself ──

function fakeSchedulers() {
  const oneShots: Array<() => void> = []
  const repeats: Array<() => void> = []
  const state = { cancelled: 0, cleared: 0 }
  return {
    oneShots,
    repeats,
    state,
    schedule: (fn: () => void) => {
      oneShots.push(fn)
      return oneShots.length
    },
    cancelScheduled: () => {
      state.cancelled += 1
    },
    setTimer: (fn: () => void) => {
      repeats.push(fn)
      return repeats.length
    },
    clearTimer: () => {
      state.cleared += 1
    },
  }
}

const PROJECT = join('/tmp', 'connected-project')
const CLAUDE_DIR = join(PROJECT, '.claude')
const MEMORY_DIR = join(CLAUDE_DIR, 'memory')

const V1_NOTE = ['---', 'kind: bug-lesson', 'tags: [daemon, watch]', 'description: не смотри на mtime', '---', '', 'тело урока'].join('\n')
const V1_NOTE_2 = ['---', 'kind: procedural-rule', 'tags: [daemon]', 'description: правило', '---', '', 'тело правила'].join('\n')
const V2_NOTE = [
  '---',
  'schema_version: 2',
  'id: already-v2',
  'memory_type: procedural',
  'truth_mode: normative',
  'claim: уже второй схемы',
  'status: active',
  'language: ru',
  'tags: [daemon]',
  'description: уже мигрирована',
  '---',
  '',
  'тело',
].join('\n')

function baseTree(): Tree {
  return {
    [CLAUDE_DIR]: { 'settings.json': '{}' },
    [MEMORY_DIR]: { 'MEMORY.md': '# индекс\n', 'a-note.md': V1_NOTE },
  }
}

function start(over: Record<string, unknown> = {}) {
  const emitted: Array<Record<string, unknown>> = []
  const degradations: Array<string> = []
  const tree = (over.tree as Tree) ?? baseTree()
  const watcher = (over.watcher as ReturnType<typeof fakeWatch>) ?? fakeWatch()
  const sched = fakeSchedulers()
  const handle = watchProject({
    projectDir: PROJECT,
    projectId: 'sma-dev',
    emit: (frame: Record<string, unknown>) => emitted.push(frame),
    watchImpl: watcher.impl,
    fsImpl: fakeFs(tree, (over.mtimes as Record<string, number>) ?? {}),
    schedule: sched.schedule,
    cancelScheduled: sched.cancelScheduled,
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    onDegrade: (reason: string) => degradations.push(reason),
    ...(over.opts as object),
  })
  return { handle, emitted, degradations, watcher, sched, tree }
}

describe('watchProject — debounced hints', () => {
  it('a burst of ten filesystem events inside the debounce window is ONE hint, not ten', () => {
    const { emitted, sched, watcher, handle } = start()

    watcher.fire(10)
    expect(sched.oneShots.length).toBe(1) // one debounce armed, not ten
    expect(emitted.length).toBe(0) // nothing before the window closes

    sched.oneShots[0]()
    expect(emitted.length).toBe(1)

    stopWatch(handle)
  })

  it('a hint frame is a doorbell — the event and the project id, never a file name', () => {
    const { emitted, sched, watcher, handle } = start()

    watcher.fire(1)
    sched.oneShots[0]()

    expect(emitted[0]).toEqual({ event: 'project.updated', projectId: 'sma-dev' })
    const text = JSON.stringify(emitted[0])
    expect(text).not.toContain('a-note.md')
    expect(text).not.toContain('/tmp')

    stopWatch(handle)
  })

  it('a second burst after the window closed arms a new window and emits again', () => {
    const { emitted, sched, watcher, handle } = start()

    watcher.fire(3)
    sched.oneShots[0]()
    watcher.fire(3)
    expect(sched.oneShots.length).toBe(2)
    sched.oneShots[1]()

    expect(emitted.length).toBe(2)
    stopWatch(handle)
  })

  it('the watched paths are the configuration and the corpus, never the whole project tree', () => {
    const { watcher, handle } = start()

    expect(watcher.watched).toContain(CLAUDE_DIR)
    expect(watcher.watched).toContain(MEMORY_DIR)
    expect(watcher.watched).not.toContain(PROJECT)

    stopWatch(handle)
  })
})

describe('watchProject — the reconcile that survives a dropped event', () => {
  it('emits when the surface digest changed with NO watch event at all', () => {
    const { emitted, sched, tree, handle } = start()

    tree[MEMORY_DIR]['b-note.md'] = V1_NOTE_2 // a change no watch event announced
    sched.repeats[0]()

    expect(emitted.length).toBe(1)
    expect(emitted[0].event).toBe('project.updated')

    stopWatch(handle)
  })

  it('emits NOTHING when the surface is unchanged — no heartbeat to learn to ignore', () => {
    const { emitted, sched, handle } = start()

    sched.repeats[0]()
    sched.repeats[0]()
    sched.repeats[0]()

    expect(emitted.length).toBe(0)
    stopWatch(handle)
  })

  it('a hint already sent for a change is not sent a second time by the reconcile', () => {
    const { emitted, sched, watcher, tree, handle } = start()

    tree[MEMORY_DIR]['b-note.md'] = V1_NOTE_2
    watcher.fire(1)
    sched.oneShots[0]() // the watch path emitted for this change
    expect(emitted.length).toBe(1)

    sched.repeats[0]() // the reconcile sees the same surface it just announced
    expect(emitted.length).toBe(1)

    stopWatch(handle)
  })

  it('a mtime-only edit of one note still moves the digest', () => {
    const mtimes: Record<string, number> = {}
    const { emitted, sched, handle } = start({ mtimes })

    mtimes[join(MEMORY_DIR, 'a-note.md')] = 999999
    sched.repeats[0]()

    expect(emitted.length).toBe(1)
    stopWatch(handle)
  })
})

describe('watchProject — degradation is reported, never hidden', () => {
  it('a throwing watch implementation degrades to reconcile-only and says so ONCE', () => {
    const watcher = fakeWatch({ throws: true })
    const { handle, degradations, emitted, sched, tree } = start({ watcher })

    expect(handle.degraded).toBe(true)
    expect(degradations.length).toBe(1) // once — not once per watched directory
    expect(String(handle.degradedReason)).not.toBe('')

    // reconcile-only still keeps the screen honest
    tree[MEMORY_DIR]['b-note.md'] = V1_NOTE_2
    sched.repeats[0]()
    expect(emitted.length).toBe(1)

    stopWatch(handle)
  })

  it('a watcher that errors at runtime degrades once and keeps reconciling', () => {
    const { handle, degradations, watcher, sched, tree, emitted } = start()

    expect(handle.degraded).toBe(false)
    for (const fn of watcher.errorHandlers) fn(new Error('EPERM'))

    expect(handle.degraded).toBe(true)
    expect(degradations.length).toBe(1)

    tree[MEMORY_DIR]['b-note.md'] = V1_NOTE_2
    sched.repeats[0]()
    expect(emitted.length).toBe(1)

    stopWatch(handle)
  })

  it('a project directory that does not exist emits nothing and does not throw', () => {
    const watcher = fakeWatch({ throws: true }) // node throws ENOENT on a missing path
    const { handle, emitted, sched } = start({ tree: {}, watcher })

    expect(() => sched.repeats[0]()).not.toThrow()
    sched.repeats[0]()
    expect(emitted.length).toBe(0)

    expect(() => stopWatch(handle)).not.toThrow()
  })
})

describe('stopWatch', () => {
  it('closes every watcher, clears the interval, and a second call is a no-op', () => {
    const { handle, watcher, sched } = start()

    stopWatch(handle)
    expect(watcher.closed.length).toBe(2)
    expect(sched.state.cleared).toBe(1)
    expect(handle.stopped).toBe(true)

    stopWatch(handle)
    expect(watcher.closed.length).toBe(2)
    expect(sched.state.cleared).toBe(1)
  })

  it('a pending debounce is cancelled and never fires a hint after the stop', () => {
    const { handle, watcher, sched, emitted } = start()

    watcher.fire(1)
    stopWatch(handle)
    expect(sched.state.cancelled).toBe(1)

    sched.oneShots[0]() // even if the host fired it anyway
    expect(emitted.length).toBe(0)
  })

  it('stopWatch(undefined) is a no-op', () => {
    expect(() => stopWatch(undefined)).not.toThrow()
    expect(() => stopWatch(null)).not.toThrow()
  })
})

describe('readProjectMemory — a surface over a project the daemon does not own', () => {
  it('reports the corpus as counts, tags and pointers — no body, no absolute path', () => {
    const surface = readProjectMemory({ projectDir: PROJECT, fsImpl: fakeFs(baseTree()) })

    expect(surface.absent).toBeUndefined()
    expect(surface.noteCount).toBe(1)
    expect(surface.tags.map((t: { tag: string }) => t.tag).sort()).toEqual(['daemon', 'watch'])
    expect(surface.recent[0]).toEqual({ id: 'a-note', title: 'не смотри на mtime' })

    const text = JSON.stringify(surface)
    expect(text).not.toContain('тело урока') // no body
    expect(text).not.toContain('/tmp') // no absolute path
    expect(text).not.toContain(PROJECT)
  })

  it('reports the corpus generation so the screen knows whether a preview is relevant', () => {
    const v1 = readProjectMemory({ projectDir: PROJECT, fsImpl: fakeFs(baseTree()) })
    expect(v1.generation).toBe('v1')
    expect(v1.migratable).toBe(true)
    expect(v1.v1Count).toBe(1)

    const v2tree = baseTree()
    v2tree[MEMORY_DIR] = { 'MEMORY.md': '# индекс\n', 'already-v2.md': V2_NOTE }
    const v2 = readProjectMemory({ projectDir: PROJECT, fsImpl: fakeFs(v2tree) })
    expect(v2.generation).toBe('v2')
    expect(v2.migratable).toBe(false)

    const mixed = baseTree()
    mixed[MEMORY_DIR]['already-v2.md'] = V2_NOTE
    const both = readProjectMemory({ projectDir: PROJECT, fsImpl: fakeFs(mixed) })
    expect(both.generation).toBe('mixed')
    expect(both.migratable).toBe(true)
  })

  it('a project with no corpus at all is absent, not an error', () => {
    expect(readProjectMemory({ projectDir: PROJECT, fsImpl: fakeFs({}) })).toEqual({ absent: true })
    expect(readProjectMemory({ fsImpl: fakeFs(baseTree()) })).toEqual({ absent: true })
    expect(readProjectMemory()).toEqual({ absent: true })
  })

  it('holds no copy: a read after an edit reflects the edit, with no invalidation call', () => {
    const tree = baseTree()
    const io = fakeFs(tree)

    const before = readProjectMemory({ projectDir: PROJECT, fsImpl: io })
    expect(before.noteCount).toBe(1)

    tree[MEMORY_DIR]['b-note.md'] = V1_NOTE_2 // somebody edited the project

    const after = readProjectMemory({ projectDir: PROJECT, fsImpl: io })
    expect(after.noteCount).toBe(2) // no cache to invalidate, so nothing to invalidate
  })
})
