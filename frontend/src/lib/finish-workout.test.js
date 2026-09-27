import { describe, expect, it } from 'vitest'
import { buildCompletedWorkout } from './finish-workout.js'

describe('completed workout boundary', () => {
  it('builds the same legacy-shaped record doFinishWorkout stores and keeps it visible', () => {
    const active = {
      id: 'active-1', d: '2026-08-08', start: 1000, routineIds: ['routine-1'], name: 'Push', bw: 80,
      entries: [{ id: '0025', sets: [{ done: true, w: 60, r: 8 }], topW: 60, target: { sets: 1, reps: 8 } }],
    }
    const completed = buildCompletedWorkout(active, { end: 2000, prs: [] })
    expect(completed).toEqual({
      id: 'active-1', d: '2026-08-08', start: 1000, end: 2000,
      routineIds: ['routine-1'], routineId: 'routine-1', name: 'Push', bw: 80,
      entries: [{ id: '0025', sets: [{ done: true, w: 60, r: 8 }], topW: 60, target: { sets: 1, reps: 8 } }],
      prs: []
    })
  })

  it('mirrors routineIds → routineId, and tolerates a legacy scalar active.routineId', () => {
    const base = {
      id: 'w', d: '2026-08-08', start: 1,
      entries: [{ id: '0025', sets: [{ done: true, w: 60, r: 8 }], target: { sets: 1, reps: 8 } }],
    }
    const combined = buildCompletedWorkout({ ...base, routineIds: ['a', 'b'] })
    expect(combined.routineIds).toEqual(['a', 'b'])
    expect(combined.routineId).toBe('a')

    const legacy = buildCompletedWorkout({ ...base, routineId: 'only' })
    expect(legacy.routineIds).toEqual(['only'])
    expect(legacy.routineId).toBe('only')

    const freestyle = buildCompletedWorkout(base)
    expect(freestyle.routineIds).toEqual([])
    expect(freestyle.routineId).toBe(null)
  })

  it('carries per-entry rid and noProg onto the saved entry, written only when set', () => {
    const active = {
      id: 'w', d: '2026-08-08', start: 1, routineIds: ['strength', 'rehab'],
      entries: [
        { id: '0025', rid: 'strength', sets: [{ done: true, w: 60, r: 8 }], target: { sets: 1, reps: 8 } },
        { id: '0031', rid: 'rehab', noProg: true, sets: [{ done: true, w: 10, r: 12 }], target: { sets: 1, reps: 12 } },
      ],
    }
    const [a, b] = buildCompletedWorkout(active).entries
    expect(a.rid).toBe('strength')
    expect('noProg' in a).toBe(false)
    expect(b.rid).toBe('rehab')
    expect(b.noProg).toBe(true)
  })

  it('derives topW from the highest completed non-warm-up work set, not stale entry data', () => {
    const active = {
      id: 'active-1', d: '2026-08-08', start: 1000,
      entries: [{
        id: '0025', topW: 80, target: { mode: 'reps', sets: 2, reps: 8 },
        sets: [
          { phase: 'warmup', done: true, w: 120, r: 8 },
          { done: true, w: 75, r: 8 },
          { done: true, w: 85, r: 7 },
          { done: false, w: 100, r: 8 },
        ],
      }],
    }

    expect(buildCompletedWorkout(active).entries[0].topW).toBe(85)
    expect(buildCompletedWorkout({
      ...active,
      entries: [{ ...active.entries[0], topW: 120 }],
    }).entries[0].topW).toBe(85)
  })

  it('keeps a legacy topW when old completed rows have no usable weight', () => {
    const active = {
      id: 'active-1', d: '2026-08-08', start: 1000,
      entries: [{ id: '0025', topW: 60, sets: [{ done: true, r: 8 }] }],
    }

    expect(buildCompletedWorkout(active).entries[0].topW).toBe(60)
  })

  it('writes the legacy excludeFromProgression mirror iff every completed entry is noProg', () => {
    const mk = entries => ({ id: 'w', d: '2026-08-08', start: 1, routineIds: ['x'], entries })
    const done = extra => ({ id: '0025', sets: [{ done: true, w: 30, r: 8 }], target: { sets: 1, reps: 8 }, ...extra })

    // rehab-only combined session → present
    expect(buildCompletedWorkout(mk([done({ noProg: true }), done({ id: '0031', noProg: true })])))
      .toHaveProperty('excludeFromProgression', true)
    // rehab + strength → absent
    expect(buildCompletedWorkout(mk([done({ noProg: true }), done({ id: '0031' })])))
      .not.toHaveProperty('excludeFromProgression')
    // all-normal → absent
    expect(buildCompletedWorkout(mk([done(), done({ id: '0031' })])))
      .not.toHaveProperty('excludeFromProgression')
  })

  it('persists a muscle snapshot only when the caller supplies one', () => {
    const active = {
      id: 'active-1', d: '2026-08-08', start: 1000,
      entries: [
        { id: 'catalogue', sets: [{ done: true }] },
        { id: 'custom', sets: [{ done: true }] },
      ],
    }
    const completed = buildCompletedWorkout(active, {
      end: 2000,
      snapshotFor: entry => entry.id === 'custom'
        ? { n: 'Custom lift', muscleWeights: { chest: 1 } }
        : null,
    })

    expect(completed.entries[0]).not.toHaveProperty('muscleSnapshot')
    expect(completed.entries[1].muscleSnapshot).toEqual({
      n: 'Custom lift', muscleWeights: { chest: 1 },
    })
  })
})

// Notes written during a session have to survive it, or "write a note during your workout"
// means "write a note and lose it when you tap Finish".
describe('session notes', () => {
  const active = (entry) => ({
    id: 'w1', d: '2026-08-25', start: 1, routineId: 'r1', name: 'Push', bw: null,
    entries: [{ id: '0025', sets: [{ w: 100, r: 5, done: true }], ...entry }],
  })

  it('keeps a per-exercise note and its pin', () => {
    const w = buildCompletedWorkout(active({ note: '  narrower grip next time  ', notePin: true }))
    expect(w.entries[0].note).toBe('narrower grip next time')
    expect(w.entries[0].notePin).toBe(true)
  })

  it('keeps an unpinned note without inventing a pin', () => {
    const w = buildCompletedWorkout(active({ note: 'shoulder twinged' }))
    expect(w.entries[0].note).toBe('shoulder twinged')
    expect('notePin' in w.entries[0]).toBe(false)
  })

  it('writes no note fields at all when nothing was typed', () => {
    const w = buildCompletedWorkout(active({ note: '   ', notePin: true }))
    expect('note' in w.entries[0]).toBe(false)
    expect('notePin' in w.entries[0]).toBe(false)
  })

  it('keeps a whole-session note on the workout', () => {
    const a = active({})
    expect(buildCompletedWorkout({ ...a, note: 'slept badly' }).note).toBe('slept badly')
    expect('note' in buildCompletedWorkout(a)).toBe(false)
  })
})

// A superset is how the exercises were done, not only how they were planned: History and the
// MCP read it off the finished workout.
describe('supersets on the finished workout', () => {
  const set = done => ({ w: 50, r: 10, done })
  const build = entries => buildCompletedWorkout({ id: 'w', d: '2026-09-27', start: 1, name: 'Legs', entries })

  it('keeps the superset id of the members that were done back to back', () => {
    const w = build([
      { id: 'press', sets: [set(true)] },
      { id: 'leg', sets: [set(true)], sg: 'sg-1-2' },
      { id: 'calf', sets: [set(true)], sg: 'sg-1-2' },
    ])
    expect(w.entries.map(e => e.sg)).toEqual([undefined, 'sg-1-2', 'sg-1-2'])
    expect('sg' in w.entries[0]).toBe(false)
  })

  it('drops the id when its partner had nothing done and is left out', () => {
    const w = build([
      { id: 'leg', sets: [set(true)], sg: 'pair' },
      { id: 'calf', sets: [set(false)], sg: 'pair' },
      { id: 'curl', sets: [set(true)] },
    ])
    expect(w.entries.map(e => e.id)).toEqual(['leg', 'curl'])
    expect(w.entries.some(e => 'sg' in e)).toBe(false)
  })

  it('does not touch the session it was built from', () => {
    const entries = [{ id: 'leg', sets: [set(true)], sg: 'pair' }, { id: 'calf', sets: [set(false)], sg: 'pair' }]
    build(entries)
    expect(entries.map(e => e.sg)).toEqual(['pair', 'pair'])
  })
})

// finishSession / sessionPrs: the finish button's effects on the profile, now one function shared
// with the MCP server's log_workout. These pin what doFinishWorkout did inline before it moved.
import { finishSession, sessionPrs } from './finish-workout.js'
import { EXDB, isCardio, isAssisted } from './exercises.js'

describe('finishSession — what finishing does to the profile', () => {
  const bench = '0025'
  const assisted = (EXDB.find(e => isAssisted(e.id) && !isCardio(e.id)) || {}).id
  const profile = () => ({
    exWeights: { [bench]: { w: 60, d: '2026-08-01' } },
    workouts: [
      { id: 'w1', d: '2026-08-01', start: 100, end: 200, name: 'Push', entries: [{ id: bench, sets: [{ w: 60, r: 5, done: true }] }], prs: [] },
      { id: 'w2', d: '2026-08-10', start: 300, end: 400, name: 'Push', entries: [{ id: bench, sets: [{ w: 60, r: 5, done: true }] }], prs: [] }
    ]
  })
  const session = (sets, extra = {}) => ({
    id: 'new', d: '2026-08-20', start: 1000, routineIds: ['r1'], name: 'Push', bw: 80,
    entries: [{ id: bench, sets, target: { sets: 3, reps: 5, weight: 62.5, mode: 'reps' }, rid: 'r1' }], ...extra
  })

  it('a live session: heavier work set is a PR, the working weight goes up, the record is appended with its volume', () => {
    const S = profile()
    const { workout, prs } = finishSession(S, session([{ w: 62.5, r: 5, done: true }, { w: 62.5, r: 5, done: true }]), { now: 5000 })
    expect(prs).toEqual([bench])
    expect(workout.prs).toEqual([bench])
    expect(workout.end).toBe(5000)
    expect(workout.vol).toBe(625)
    expect(S.exWeights[bench]).toEqual({ w: 62.5, d: '2026-08-20' })
    expect(S.workouts.at(-1).id).toBe('new')
  })

  it('a warm-up row is never a record, and the same weight is not a PR', () => {
    const S = profile()
    const { prs } = finishSession(S, session([{ w: 100, r: 3, done: true, phase: 'warmup' }, { w: 60, r: 5, done: true }]), { now: 5000 })
    expect(prs).toEqual([])
    expect(S.exWeights[bench].w).toBe(60)
  })

  it('an exercise with no completed work is not kept, and changes nothing', () => {
    const S = profile()
    const { workout } = finishSession(S, session([{ w: 90, r: 5, done: false }]), { now: 5000 })
    expect(workout.entries).toEqual([])
    expect(S.exWeights[bench].w).toBe(60)
  })

  it('a past session claims no records, leaves the working weights, and is filed in date order', () => {
    const S = profile()
    const past = session([{ w: 80, r: 5, done: true }], { d: '2026-08-05', start: 250, backfill: { durationMin: 45, replaceId: null } })
    const { workout, prs } = finishSession(S, past)
    expect(prs).toEqual([])
    expect(workout.end).toBe(250 + 45 * 60000)
    expect(S.exWeights[bench].w).toBe(60)
    expect(S.workouts.map(w => w.id)).toEqual(['w1', 'new', 'w2'])
  })

  it('a past session can replace the workout it was logged over', () => {
    const S = profile()
    finishSession(S, session([{ w: 55, r: 5, done: true }], { d: '2026-08-10', start: 300, backfill: { durationMin: 60, replaceId: 'w2' } }))
    expect(S.workouts.map(w => w.id)).toEqual(['w1', 'new'])
  })

  it('sessionPrs reads the history before the session, the same as finishSession', () => {
    const S = profile()
    expect(sessionPrs(S, session([{ w: 65, r: 1, done: true }]))).toEqual([bench])
    expect(sessionPrs(S, session([{ w: 65, r: 1, done: true }], { backfill: { durationMin: 60 } }))).toEqual([])
  })

  it.skipIf(!assisted)('on an assisted machine less help is the record', () => {
    const S = { exWeights: { [assisted]: { w: 40, d: 'x' } }, workouts: [{ id: 'a', d: '2026-08-01', start: 1, entries: [{ id: assisted, sets: [{ w: 40, r: 8, done: true }] }] }] }
    const s = { id: 'n', d: '2026-08-20', start: 2, routineIds: [], name: 'x', entries: [{ id: assisted, sets: [{ w: 30, r: 8, done: true }] }] }
    const { prs } = finishSession(S, s, { now: 3 })
    expect(prs).toEqual([assisted])
    expect(S.exWeights[assisted].w).toBe(30)
  })

  it('a profile without workouts or working weights yet still takes its first session', () => {
    const S = {}
    finishSession(S, session([{ w: 40, r: 5, done: true }]), { now: 9 })
    expect(S.workouts).toHaveLength(1)
    expect(S.exWeights[bench].w).toBe(40)
  })
})
