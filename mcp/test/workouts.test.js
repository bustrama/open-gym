// log_workout / delete_workout: a logged session must land the way finishing it in the app would
// (finishSession): PRs and working weights for the newest workout only, date-order filing and no
// records for anything behind it, same-day refusal/add/replace like "Log a past workout".
import { describe, test, expect, beforeEach } from 'vitest'
import { EXDB, isCardio, isBodyweightEq } from '../../frontend/src/lib/exercises.js'
import { writeTools, todayFor, zonedEpoch } from '../src/edit-tools.js'
import { workoutTools } from '../src/workout-tools.js'
import { buildCombinedEntries } from '../../frontend/src/lib/session-merge.js'
import { harness, clone } from './helpers.js'

const bench = '0025'
const cardio = EXDB.find(e => isCardio(e.id)).id
const plank = (EXDB.find(e => /plank/i.test(e.n) && isBodyweightEq(e.id)) || {}).id
const cfg = { id: bench, sets: 3, mode: 'reps', reps: 5, weight: 62.5 }
const base = () => ({
  unit: 'kg', reminder: { on: false, time: '08:00', tz: 'UTC' },
  routines: [{ id: 'rPush', name: 'Push', emoji: 'barbell', ex: [cfg] }, { id: 'rLegs', name: 'Legs', emoji: 'legs', ex: [] }],
  week: {}, dayPlan: {}, bodyweight: [], customEx: [],
  exWeights: { [bench]: { w: 60, d: '2026-01-01' } },
  workouts: [{ id: 'wOld', d: '2026-01-01', start: Date.parse('2026-01-01T18:00:00'), end: Date.parse('2026-01-01T19:00:00'), routineIds: ['rPush'], routineId: 'rPush', name: 'Push', bw: null, entries: [{ id: bench, sets: [{ w: 60, r: 5, done: true }], topW: 60, target: cfg, rid: 'rPush' }], prs: [], vol: 300 }]
})

let h
beforeEach(() => { h = harness(base(), [writeTools, workoutTools]) })
const last = () => h.srv.state.workouts.at(-1)
const today = () => todayFor(h.srv.state)
const benchSets = (w, n = 3) => Array.from({ length: n }, () => ({ weight: w, reps: 5 }))

describe('log_workout — the newest workout: live rules', () => {
  test('a routine session: PR, working weight raised, target and routine carried, volume, appended last', async () => {
    const r = await h.call('log_workout', { routine_ids: ['rPush'], duration_min: 50, entries: [{ exercise_id: bench, sets: benchSets(62.5) }] })
    expect(r.ok).toBe(true)
    expect(r.prs).toEqual(['barbell bench press'])
    expect(r.filed).toMatch(/newest/)
    const w = last()
    expect(w).toMatchObject({ id: r.workout_id, d: today(), name: 'Push', routineIds: ['rPush'], routineId: 'rPush', prs: [bench], vol: 937.5 })
    expect(w.end - w.start).toBe(50 * 60000)
    // The target is the day's prescription the app computes at session start, not the raw plan.
    const planned = buildCombinedEntries(base(), ['rPush']).entries[0]
    expect(w.entries[0]).toMatchObject({ id: bench, rid: 'rPush', target: planned.target, topW: 62.5 })
    expect(w.entries[0].sets).toEqual(Array(3).fill({ w: 62.5, r: 5, done: true }))
    expect(h.srv.state.exWeights[bench]).toEqual({ w: 62.5, d: today() })
  })

  test('warm-ups and effort ride on the sets; a warm-up is never the record', async () => {
    const r = await h.call('log_workout', { routine_ids: ['rPush'], entries: [{ exercise_id: bench, sets: [{ weight: 100, reps: 1, warmup: true }, { weight: 60, reps: 5, rir: 2 }] }] })
    expect(r.prs).toEqual([])
    expect(last().entries[0].sets).toEqual([{ w: 100, r: 1, done: true, phase: 'warmup' }, { w: 60, r: 5, done: true, rir: 2 }])
    expect(h.srv.state.exWeights[bench].w).toBe(60)
  })

  test('freestyle, an extra exercise, cardio and a timed hold each get the set shape the app stores', async () => {
    const entries = [
      { exercise_id: cardio, sets: [{ minutes: 20, speed: 9 }] },
      ...(plank ? [{ exercise_id: plank, sets: [{ seconds: 60 }, { seconds: 45 }] }] : [])
    ]
    await h.call('log_workout', { entries })
    const w = last()
    expect(w.name).toBe('Freestyle')
    expect(w.routineIds).toEqual([])
    expect(w.entries[0]).toMatchObject({ id: cardio, target: null, sets: [{ min: 20, speed: 9, done: true }] })
    if (plank) expect(w.entries[1].sets).toEqual([{ sec: 60, w: 0, done: true }, { sec: 45, w: 0, done: true }])
  })

  test('bodyweight is the session\'s and that day\'s weigh-in, like the start-of-workout sheet', async () => {
    await h.call('log_workout', { bodyweight: 80.26, entries: [{ exercise_id: bench, sets: benchSets(50, 1) }] })
    expect(last().bw).toBe(80.26)
    expect(h.srv.state.bodyweight).toEqual([expect.objectContaining({ d: today(), w: 80.3 })])
  })
})

describe('log_workout — filed behind another: past rules', () => {
  test('a day in the past: no PR, working weight untouched, filed in date order', async () => {
    const r = await h.call('log_workout', { date: '2025-12-20', start_time: '07:30', duration_min: 40, routine_ids: ['rPush'], entries: [{ exercise_id: bench, sets: benchSets(80) }] })
    expect(r.prs).toEqual([])
    expect(r.filed).toMatch(/history/)
    expect(h.srv.state.workouts.map(w => w.id)).toEqual([r.workout_id, 'wOld'])
    const w = h.srv.state.workouts[0]
    expect(w.end - w.start).toBe(40 * 60000)
    expect(h.srv.state.exWeights[bench].w).toBe(60)
  })

  test('same day: refused by default, added on request, or replaced — which is how a workout is edited', async () => {
    await expect(h.call('log_workout', { date: '2026-01-01', entries: [{ exercise_id: bench, sets: benchSets(55) }] })).rejects.toMatchObject({ code: 'EEXISTS' })
    const add = await h.call('log_workout', { date: '2026-01-01', start_time: '20:00', on_same_day: 'add', entries: [{ exercise_id: bench, sets: benchSets(55) }] })
    expect(h.srv.state.workouts.filter(w => w.d === '2026-01-01')).toHaveLength(2)
    await expect(h.call('log_workout', { date: '2026-01-01', on_same_day: 'replace', entries: [{ exercise_id: bench, sets: benchSets(55) }] }))
      .rejects.toThrow(/several workouts/)
    const rep = await h.call('log_workout', { date: '2026-01-01', on_same_day: 'replace', replace_workout_id: add.workout_id, entries: [{ exercise_id: bench, sets: benchSets(57.5) }] })
    expect(rep.replaced).toBe(add.workout_id)
    expect(h.srv.state.workouts.some(w => w.id === add.workout_id)).toBe(false)
    expect(h.srv.state.workouts.find(w => w.id === rep.workout_id).entries[0].topW).toBe(57.5)
  })
})

describe('log_workout — refusals', () => {
  test('unknown exercise or routine, the future, or a set without reps — nothing written', async () => {
    const writes = h.srv.writes
    await expect(h.call('log_workout', { entries: [{ exercise_id: 'nope', sets: [{ reps: 5 }] }] })).rejects.toMatchObject({ code: 'EINVALID' })
    await expect(h.call('log_workout', { routine_ids: ['ghost'], entries: [{ exercise_id: bench, sets: [{ reps: 5 }] }] })).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(h.call('log_workout', { date: '2999-01-01', entries: [{ exercise_id: bench, sets: [{ reps: 5 }] }] })).rejects.toMatchObject({ code: 'EINVALID' })
    await expect(h.call('log_workout', { entries: [{ exercise_id: bench, sets: [{ weight: 50 }] }] })).rejects.toThrow(/needs reps/)
    await expect(h.call('log_workout', { entries: [{ exercise_id: cardio, sets: [{ reps: 5 }] }] })).rejects.toThrow(/needs minutes/)
    expect(h.srv.writes).toBe(writes)
  })
})

describe('log_workout — review fixes', () => {
  test("a start time is the athlete's wall clock in their zone, whatever the server runs in", async () => {
    h.srv.state.reminder = { on: false, time: '08:00', tz: 'America/Los_Angeles' }
    const r = await h.call('log_workout', { date: '2025-12-20', start_time: '18:00', entries: [{ exercise_id: bench, sets: benchSets(50, 1) }] })
    expect(h.srv.state.workouts.find(x => x.id === r.workout_id).start).toBe(zonedEpoch('2025-12-20', '18:00', 'America/Los_Angeles'))
  })

  test('the same request_id logs the workout once', async () => {
    const a = await h.call('log_workout', { request_id: 'w-1', entries: [{ exercise_id: bench, sets: benchSets(50, 1) }] })
    const b = await h.call('log_workout', { request_id: 'w-1', on_same_day: 'add', entries: [{ exercise_id: bench, sets: benchSets(50, 1) }] })
    expect(b.duplicate).toBe(true)
    expect(b.workout_id).toBe(a.workout_id)
    expect(h.srv.state.workouts.filter(x => x.id === a.workout_id)).toHaveLength(1)
    expect(h.srv.state.workouts).toHaveLength(2)
  })
})

describe('undo and delete', () => {
  test('undoing a logged workout takes the record and the raised working weight back', async () => {
    const before = clone(h.srv.state)
    await h.call('log_workout', { routine_ids: ['rPush'], entries: [{ exercise_id: bench, sets: benchSets(70) }] })
    expect(h.srv.state.exWeights[bench].w).toBe(70)
    await h.call('undo_last_change', {})
    expect(h.srv.state.workouts).toEqual(before.workouts)
    expect(h.srv.state.exWeights).toEqual(before.exWeights)
  })

  test('delete removes the record; undo puts it back where it was', async () => {
    const r = await h.call('log_workout', { date: '2025-12-20', routine_ids: ['rPush'], entries: [{ exercise_id: bench, sets: benchSets(50) }] })
    const order = h.srv.state.workouts.map(w => w.id)
    const d = await h.call('delete_workout', { workout_id: r.workout_id })
    expect(d.deleted).toMatchObject({ workout_id: r.workout_id, date: '2025-12-20' })
    expect(h.srv.state.workouts.map(w => w.id)).toEqual(['wOld'])
    await h.call('undo_last_change', {})
    expect(h.srv.state.workouts.map(w => w.id)).toEqual(order)
    await expect(h.call('delete_workout', { workout_id: 'ghost' })).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
