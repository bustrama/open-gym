import { describe, expect, it } from 'vitest'
import { activeWorkoutOverview, canMoveActiveWorkoutUnit, canPostponeActiveWorkoutUnit, moveActiveWorkoutUnit, postponeActiveWorkoutUnit, upNextAfterRest } from './active-workout-order.js'
import { LANGS, DERIVED_LOCALES } from './i18n-core.js'
import { PT_BR_OVERRIDES } from '../locales/pt-BR.js'

const entry = (id, extra = {}) => ({
  id,
  target: { sets: 1, reps: 5 },
  sets: [{ w: 0, r: 5, done: false }],
  ...extra,
})

describe('active workout whole-unit order', () => {
  it('moves one standalone occurrence without conflating duplicate exercise ids', () => {
    const duplicateA = entry('duplicate', { occurrenceId: 'duplicate#1' })
    const selected = entry('duplicate', {
      occurrenceId: 'duplicate#2',
      target: { sets: 2, reps: 7, weight: 82.5, notes: 'Keep this target' },
      sets: [{ w: 77.5, r: 6, done: true, rir: 2 }],
    })
    const active = { cur: 2, entries: [duplicateA, entry('middle'), selected] }

    expect(moveActiveWorkoutUnit(active, active.cur, -1)?.indices).toEqual([0, 2, 1])
    expect(active.entries.map(item => item.occurrenceId || item.id)).toEqual(['duplicate#1', 'duplicate#2', 'middle'])
    expect(active.entries[0]).toBe(duplicateA)
    expect(active.entries[1]).toBe(selected)
    expect(active.entries[1].target).toBe(selected.target)
    expect(active.entries[1].sets).toBe(selected.sets)
    expect(active.cur).toBe(1)
  })

  it('moves a complete contiguous group one unit and preserves the selected member identity', () => {
    const first = entry('group-a', { sg: 'pair', occurrenceId: 'group-a#1' })
    const selected = entry('group-b', { sg: 'pair', occurrenceId: 'group-b#1' })
    const groupMeta = { pair: { kind: 'complex', label: 'Carry pair', cues: 'Stay braced.' } }
    const active = { cur: 2, entries: [entry('before'), first, selected, entry('after')], groupMeta }

    expect(moveActiveWorkoutUnit(active, active.cur, -1)?.indices).toEqual([1, 2, 0, 3])
    expect(active.entries.map(item => item.id)).toEqual(['group-a', 'group-b', 'before', 'after'])
    expect(active.entries.slice(0, 2)).toEqual([first, selected])
    expect(active.entries.map(item => item.sg)).toEqual(['pair', 'pair', undefined, undefined])
    expect(active.groupMeta).toBe(groupMeta)
    expect(active.entries[active.cur]).toBe(selected)
  })

  it('moves a group down by exactly one neighbouring unit', () => {
    const first = entry('group-a', { sg: 'pair' })
    const selected = entry('group-b', { sg: 'pair' })
    const active = { cur: 1, entries: [first, selected, entry('middle'), entry('last')] }

    expect(moveActiveWorkoutUnit(active, active.cur, 1)?.indices).toEqual([2, 0, 1, 3])
    expect(active.entries.map(item => item.id)).toEqual(['middle', 'group-a', 'group-b', 'last'])
    expect(active.entries[active.cur]).toBe(selected)
  })

  it('rejects boundaries and invalid directions without mutating the active workout', () => {
    const active = { cur: 0, entries: [entry('first'), entry('last')] }
    const entries = [...active.entries]

    expect(canMoveActiveWorkoutUnit(active, 0, -1)).toBe(false)
    expect(canMoveActiveWorkoutUnit(active, 1, 1)).toBe(false)
    expect(moveActiveWorkoutUnit(active, 0, 0)).toBeNull()
    expect(moveActiveWorkoutUnit(active, 0, -1)).toBeNull()
    expect(active.entries).toEqual(entries)
    expect(active.cur).toBe(0)
  })
})

const done = (id, extra = {}) => entry(id, { sets: [{ w: 0, r: 5, done: true }], ...extra })
const ids = active => active.entries.map(item => item.id)

describe('do later (postpone a unit behind the unfinished ones)', () => {
  it('moves the current exercise behind the last unfinished unit and marks the one that came next', () => {
    const active = { cur: 1, entries: [done('a'), entry('b'), entry('c'), entry('d'), done('e')] }

    expect(postponeActiveWorkoutUnit(active, 1)?.indices).toEqual([0, 2, 3, 1, 4])
    expect(ids(active)).toEqual(['a', 'c', 'd', 'b', 'e'])
    expect(active.entries[active.cur].id).toBe('c')
  })

  it('skips finished units when it picks the next one to mark', () => {
    const active = { cur: 0, entries: [entry('a'), done('b'), entry('c')] }

    postponeActiveWorkoutUnit(active, 0)
    expect(ids(active)).toEqual(['b', 'c', 'a'])
    expect(active.entries[active.cur].id).toBe('c')
  })

  it('keeps a unit that is already behind every unfinished one in place and wraps the marker', () => {
    const active = { cur: 1, entries: [entry('a'), entry('b'), done('c')] }

    expect(postponeActiveWorkoutUnit(active, 1)?.indices).toEqual([0, 1, 2])
    expect(ids(active)).toEqual(['a', 'b', 'c'])
    expect(active.cur).toBe(0)
  })

  it('moves a whole superset as one unit and keeps its members in order', () => {
    const first = entry('group-a', { sg: 'pair' })
    const second = entry('group-b', { sg: 'pair', sets: [{ w: 0, r: 5, done: true }, { w: 0, r: 5, done: false }] })
    const active = { cur: 2, entries: [entry('warm'), first, second, entry('last')] }

    expect(postponeActiveWorkoutUnit(active, 2)?.indices).toEqual([0, 3, 1, 2])
    expect(active.entries.slice(2)).toEqual([first, second])
    expect(active.entries.map(item => item.sg)).toEqual([undefined, undefined, 'pair', 'pair'])
    expect(active.entries[active.cur].id).toBe('last')
  })

  it('leaves the marker on its own entry when another unit is postponed', () => {
    const current = entry('current')
    const active = { cur: 2, entries: [entry('a'), entry('b'), current, entry('d')] }

    postponeActiveWorkoutUnit(active, 0)
    expect(ids(active)).toEqual(['b', 'current', 'd', 'a'])
    expect(active.entries[active.cur]).toBe(current)
  })

  it('keeps duplicate occurrences of one exercise apart', () => {
    const second = entry('dup', { occurrenceId: 'dup#2' })
    const active = { cur: 0, entries: [entry('dup', { occurrenceId: 'dup#1' }), entry('mid'), second] }

    postponeActiveWorkoutUnit(active, 0)
    expect(active.entries.map(item => item.occurrenceId || item.id)).toEqual(['mid', 'dup#2', 'dup#1'])
    expect(active.entries[active.cur].id).toBe('mid')
  })

  it('refuses a finished unit, the last unfinished unit and bad indexes without touching the session', () => {
    const cases = [
      [{ cur: 0, entries: [done('a'), entry('b')] }, 0],
      [{ cur: 1, entries: [done('a'), entry('b'), done('c')] }, 1],
      [{ cur: 0, entries: [entry('a')] }, 0],
      [{ cur: 0, entries: [entry('a'), entry('b')] }, 5],
      [{ cur: 0, entries: [] }, 0],
    ]
    for (const [active, index] of cases) {
      const before = structuredClone(active)
      expect(canPostponeActiveWorkoutUnit(active, index)).toBe(false)
      expect(postponeActiveWorkoutUnit(active, index)).toBeNull()
      expect(active).toEqual(before)
    }
    expect(canPostponeActiveWorkoutUnit(null, 0)).toBe(false)
  })

  it('treats a half-done per-side set as work still to do', () => {
    const side = { sides: { L: { w: 10, r: 8, done: true }, R: { w: 10, r: 8, done: false } }, done: false }
    const active = { cur: 0, entries: [entry('a', { sets: [side] }), entry('b')] }

    expect(canPostponeActiveWorkoutUnit(active, 0)).toBe(true)
  })
})

describe('exercises overview rows', () => {
  it('lists one row per unit with set counts, a status and the current marker', () => {
    const active = {
      cur: 2,
      entries: [
        done('a'),
        entry('b', { sg: 'pair', sets: [{ w: 0, r: 5, done: true }, { w: 0, r: 5, done: false }] }),
        entry('c', { sg: 'pair' }),
        entry('d'),
      ],
    }

    const rows = activeWorkoutOverview(active)
    expect(rows.map(row => [row.indices, row.status, row.done, row.total, row.current])).toEqual([
      [[0], 'done', 1, 1, false],
      [[1, 2], 'started', 1, 3, true],
      [[3], 'todo', 0, 1, false],
    ])
    expect(rows[1].members.map(m => [m.idx, m.id, m.status])).toEqual([[1, 'b', 'started'], [2, 'c', 'todo']])
  })

  it('counts a per-side set as two, like the header does', () => {
    const side = { sides: { L: { w: 10, r: 8, done: true }, R: { w: 10, r: 8, done: false } }, done: false }
    const [row] = activeWorkoutOverview({ cur: 0, entries: [entry('a', { sets: [side] })] })

    expect([row.done, row.total, row.status]).toEqual([1, 2, 'started'])
  })

  it('clamps a stale marker and returns nothing for an empty session', () => {
    expect(activeWorkoutOverview({ cur: 9, entries: [entry('a'), entry('b')] }).map(row => row.current)).toEqual([false, true])
    expect(activeWorkoutOverview({ cur: 0, entries: [] })).toEqual([])
    expect(activeWorkoutOverview(null)).toEqual([])
  })
})

describe('up next after a rest', () => {
  it('names the next unfinished unit once the resting unit is finished', () => {
    const active = { cur: 0, entries: [done('a'), done('b'), entry('c', { sg: 'p' }), entry('d', { sg: 'p' })] }

    expect(upNextAfterRest(active, 0)).toEqual([2, 3])
  })

  it('wraps to earlier unfinished work', () => {
    expect(upNextAfterRest({ cur: 2, entries: [entry('a'), done('b'), done('c')] }, 2)).toEqual([0])
  })

  it('has nothing to announce mid-exercise, mid-superset, at the end, or for an unknown owner', () => {
    const midExercise = { cur: 0, entries: [entry('a', { sets: [{ done: true }, { done: false }] }), entry('b')] }
    const midSuperset = { cur: 0, entries: [done('a', { sg: 'p' }), entry('b', { sg: 'p' }), entry('c')] }
    const allDone = { cur: 0, entries: [done('a'), done('b')] }

    expect(upNextAfterRest(midExercise, 0)).toBeNull()
    expect(upNextAfterRest(midSuperset, 0)).toBeNull()
    expect(upNextAfterRest(allDone, 1)).toBeNull()
    expect(upNextAfterRest(allDone, undefined)).toBeNull()
    expect(upNextAfterRest(allDone, 7)).toBeNull()
  })
})

describe('active workout move locale coverage', () => {
  const packs = import.meta.glob('../locales/*.js', { eager: true, import: 'default' })
  // English is the source language and has no pack. Derived locales (de-CH) have none either:
  // they transform their base language's pack at load time, and are checked separately below.
  const localeCodes = Object.keys(LANGS).filter(code => code !== 'en' && !DERIVED_LOCALES[code])

  const labels = ['Move up', 'Move down', 'Do later', '“{0}” saved for later', 'Tap an exercise to go to it.', 'Up next: {0}', 'Add as superset']

  it('defines the move, do-later and overview labels in every current locale pack', () => {
    expect(Object.keys(packs)).toHaveLength(localeCodes.length)
    for (const code of localeCodes) {
      const pack = packs[`../locales/${code}.js`]
      expect(pack, `${code} locale pack is missing`).toBeTruthy()
      for (const key of labels) {
        expect(Object.hasOwn(pack, key), `${code} is missing ${key}`).toBe(true)
        expect(pack[key], `${code} has a blank ${key}`).toEqual(expect.any(String))
        expect(pack[key].trim(), `${code} has a blank ${key}`).not.toBe('')
      }
    }
    for (const key of labels) expect(Object.hasOwn(PT_BR_OVERRIDES, key), `pt-BR does not override ${key}`).toBe(true)
  })
})
