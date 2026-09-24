// Routine tools: what create/update/delete/reorder write must be what the routine editor would
// have saved (normalizeExConfig, cleanupSg, RoutineEdit's delete), and a routine read through
// get_routine must be writable back through update_routine without losing or changing a thing.
import { describe, test, expect, beforeEach } from 'vitest'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { EXDB, isCardio, isBodyweightEq } from '../../frontend/src/lib/exercises.js'
import { normalizeExConfig } from '../../frontend/src/lib/ex-config.js'
import { _seedStateForTests } from '../src/state.js'
import { TOOLS } from '../src/tools.js'
import { writeTools } from '../src/edit-tools.js'
import { routineTools } from '../src/routine-tools.js'
import { harness, clone } from './helpers.js'

const barbell = EXDB.find(e => !isCardio(e.id) && !isBodyweightEq(e.id) && e.eq === 'barbell').id
const dumbbell = EXDB.find(e => !isCardio(e.id) && !isBodyweightEq(e.id) && e.eq === 'dumbbell').id
const bodyweight = EXDB.find(e => !isCardio(e.id) && isBodyweightEq(e.id)).id
const cardio = EXDB.find(e => isCardio(e.id)).id

let h
beforeEach(() => { h = harness(buildDemoState(), [TOOLS, writeTools, routineTools]) })
const routine = id => h.srv.state.routines.find(r => r.id === id)
// get_routine reads the file-backed state the way the running server does; point it at the api's copy.
const read = (name, params) => { _seedStateForTests(clone(h.srv.state)); return h.call(name, params) }

describe('create_routine', () => {
  test('stores exactly what the routine editor would save, and schedules it', async () => {
    const r = await h.call('create_routine', {
      name: 'Upper A', icon: 'barbell', weekdays: ['monday', 'thursday'],
      exercises: [
        { id: barbell, sets: 4, reps: 6, weight: 80, rest_sec: 180 },
        { id: bodyweight, reps: 12, reps_max: 20 },
        { id: cardio, min: 15, speed: 9 }
      ]
    })
    expect(r.ok).toBe(true)
    const saved = routine(r.routine_id)
    expect(saved).toMatchObject({ id: r.routine_id, name: 'Upper A', emoji: 'barbell' })
    expect(saved.ex).toEqual([
      normalizeExConfig({ id: barbell, sets: 4, reps: 6, weight: 80, restSec: 180 }, saved),
      normalizeExConfig({ id: bodyweight, reps: 12, repsMax: 20 }, saved),
      normalizeExConfig({ id: cardio, min: 15, speed: 9 }, saved)
    ])
    expect(h.srv.state.week['1']).toContain(r.routine_id)
    expect(h.srv.state.week['4']).toContain(r.routine_id)
    expect(r.exercises).toHaveLength(3)
  })

  test('the app\'s defaults for anything left out, and a default icon', async () => {
    const r = await h.call('create_routine', { name: 'Bare', exercises: [{ id: barbell }] })
    const saved = routine(r.routine_id)
    expect(saved.emoji).toBe('figureStrength')
    expect(saved.ex[0]).toEqual({ id: barbell, sets: 3, mode: 'reps', reps: 10, weight: 0 })
    expect(saved.prog).toBeUndefined()
    expect(saved.excludeFromProgression).toBeUndefined()
  })

  test('superset labels: neighbours sharing one are linked; a lone label is dropped', async () => {
    const r = await h.call('create_routine', {
      name: 'SS', exercises: [
        { id: barbell, superset_group: 'A' }, { id: dumbbell, superset_group: 'A' }, { id: bodyweight, superset_group: 'B' }
      ]
    })
    const ex = routine(r.routine_id).ex
    expect(ex[0].sg).toBe('sgA')
    expect(ex[1].sg).toBe('sgA')
    expect(ex[2].sg).toBeUndefined()
  })

  test('refuses an unknown exercise, a rule that does not fit the mode, or cardio mismatches — and writes nothing', async () => {
    const writes = h.srv.writes
    await expect(h.call('create_routine', { name: 'X', exercises: [{ id: 'nope' }] })).rejects.toMatchObject({ code: 'EINVALID' })
    await expect(h.call('create_routine', { name: 'X', exercises: [{ id: barbell, mode: 'time', policy_override: 'double' }] })).rejects.toThrow(/does not apply to time/)
    await expect(h.call('create_routine', { name: 'X', exercises: [{ id: cardio, mode: 'time' }] })).rejects.toThrow(/always cardio/)
    await expect(h.call('create_routine', { name: 'X', exercises: [{ id: barbell, mode: 'cardio' }] })).rejects.toThrow(/only cardio/)
    expect(h.srv.writes).toBe(writes)
  })

  test('a custom exercise is classified the way the app classifies it', async () => {
    const s = buildDemoState()
    s.customEx = [{ id: 'cRow1', n: 'My rower', bp: 'cardio', eq: 'machine', tg: 'cardiovascular system', custom: true }]
    h = harness(s, [TOOLS, writeTools, routineTools])
    const r = await h.call('create_routine', { name: 'Row', exercises: [{ id: 'cRow1', min: 12 }] })
    expect(routine(r.routine_id).ex[0]).toEqual({ id: 'cRow1', sets: 1, min: 12, speed: 8 })
  })
})

describe('create_routine — a repeated call, and limits', () => {
  test('the same request_id returns the first routine instead of making a second', async () => {
    const a = await h.call('create_routine', { name: 'Once', request_id: 'req-1', exercises: [{ id: barbell }] })
    const b = await h.call('create_routine', { name: 'Once', request_id: 'req-1', exercises: [{ id: barbell }] })
    expect(b.duplicate).toBe(true)
    expect(b.routine_id).toBe(a.routine_id)
    expect(h.srv.state.routines.filter(x => x.name === 'Once')).toHaveLength(1)
  })

  test("limits are the app's, not tighter: a heavy load and a long drop set are accepted", async () => {
    const r = await h.call('create_routine', { name: 'Heavy', exercises: [{ id: barbell, weight: 1100, intensifier: { type: 'dropset', count: 6, pct: 60 } }] })
    expect(routine(r.routine_id).ex[0]).toMatchObject({ weight: 1100, intensifier: { type: 'dropset', count: 6, pct: 60 } })
  })
})

describe('update_routine', () => {
  test('a routine read with get_routine writes back unchanged — nothing is lost in the round trip', async () => {
    for (const r of h.srv.state.routines) {
      const got = read('get_routine', { routine_id: r.id })
      const res = await h.call('update_routine', { routine_id: r.id, exercises: got.exercises })
      expect(res.changed, `${r.name}: ${JSON.stringify(res.changes)}`).toBe(false)
    }
  })

  test('the same round trip keeps notes, warm-ups, per-side, drop sets and supersets', async () => {
    const r = await h.call('create_routine', {
      name: 'Rich', exercises: [
        { id: barbell, reps: 8, note: 'pause at the bottom', warmup_sets: 2, intensifier: { type: 'dropset', count: 2, pct: 20 }, superset_group: 'x1' },
        { id: dumbbell, reps: 11, per_side: true, superset_group: 'x1', policy_override: 'double', reps_min: 8 }
      ]
    })
    const before = clone(routine(r.routine_id))
    const got = read('get_routine', { routine_id: r.routine_id })
    const res = await h.call('update_routine', { routine_id: r.routine_id, exercises: got.exercises })
    expect(res.changed).toBe(false)
    expect(routine(r.routine_id)).toEqual(before)
  })

  test('name, icon, rule and exclusion change on their own; null puts the default rule back', async () => {
    const id = h.srv.state.routines[0].id
    const exBefore = clone(routine(id).ex)
    await h.call('update_routine', { routine_id: id, name: 'Renamed', icon: 'legs', progression: 'double', exclude_from_progression: true })
    expect(routine(id)).toMatchObject({ name: 'Renamed', emoji: 'legs', prog: 'double', excludeFromProgression: true })
    expect(routine(id).ex).toEqual(exBefore)
    await h.call('update_routine', { routine_id: id, progression: null, exclude_from_progression: false })
    expect(routine(id).prog).toBeUndefined()
    expect(routine(id).excludeFromProgression).toBeUndefined()
  })

  test('an unknown routine is ENOENT', async () => {
    await expect(h.call('update_routine', { routine_id: 'ghost', name: 'x' })).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('delete_routine / reorder_routines', () => {
  test('delete takes it off every weekday and date override; undo brings all of it back', async () => {
    const id = h.srv.state.routines[0].id
    h.srv.state.week = { 1: [id], 3: [id, h.srv.state.routines[1].id] }
    h.srv.state.dayPlan = { '2026-10-01': id, '2026-10-02': 'rest' }
    const before = clone(h.srv.state)
    await h.call('delete_routine', { routine_id: id })
    expect(routine(id)).toBeUndefined()
    expect('1' in h.srv.state.week).toBe(false)
    expect(h.srv.state.week['3']).toEqual([before.routines[1].id])
    expect('2026-10-01' in h.srv.state.dayPlan).toBe(false)
    expect(h.srv.state.dayPlan['2026-10-02']).toBe('rest')
    await h.call('undo_last_change', {})
    expect(h.srv.state.routines).toEqual(before.routines)
    expect(h.srv.state.week).toEqual(before.week)
    expect(h.srv.state.dayPlan).toEqual(before.dayPlan)
  })

  test('reorder takes a full permutation; anything else is refused', async () => {
    const ids = h.srv.state.routines.map(r => r.id)
    await h.call('reorder_routines', { routine_ids: [...ids].reverse() })
    expect(h.srv.state.routines.map(r => r.id)).toEqual([...ids].reverse())
    await expect(h.call('reorder_routines', { routine_ids: ids.slice(1) })).rejects.toMatchObject({ code: 'EINVALID' })
    await expect(h.call('reorder_routines', { routine_ids: [...ids, ids[0]] })).rejects.toMatchObject({ code: 'EINVALID' })
    await h.call('undo_last_change', {})
    expect(h.srv.state.routines.map(r => r.id)).toEqual(ids)
  })
})
