// Custom exercises, notes, favourites, bar weights: the same shapes and the same delete cascade
// as the app's sheets (CustomExForm, deleteCustomEx, the note sheet, BarWeightEditor).
import { describe, test, expect, beforeEach } from 'vitest'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { writeTools } from '../src/edit-tools.js'
import { routineTools } from '../src/routine-tools.js'
import { libraryTools } from '../src/library-tools.js'
import { READ_TOOLS } from '../src/edit-tools.js'
import { _seedStateForTests } from '../src/state.js'
import { harness } from './helpers.js'

let h
beforeEach(() => { h = harness(buildDemoState(), [READ_TOOLS, writeTools, routineTools, libraryTools]) })
const custom = id => (h.srv.state.customEx || []).find(c => c.id === id)

describe('upsert_custom_exercise', () => {
  test('creates the shape the form saves: muscles in map order, target = first primary given', async () => {
    const r = await h.call('upsert_custom_exercise', {
      name: 'Landmine Press', body_part: 'shoulders', equipment: 'barbell',
      primary_muscles: ['triceps', 'deltoids'], secondary_muscles: ['chest', 'deltoids', 'serratus'], description: '  half-kneeling  '
    })
    expect(r.created).toBe(true)
    expect(r.exercise_id).toMatch(/^c/)
    expect(custom(r.exercise_id)).toEqual({
      id: r.exercise_id, n: 'Landmine Press', bp: 'shoulders', desc: 'half-kneeling', tg: 'triceps',
      sm: ['chest', 'serratus'], muscleGroups: ['deltoids', 'triceps', 'chest', 'serratus'],
      primaries: ['deltoids', 'triceps'], secondaries: ['chest', 'serratus'], eq: 'barbell', custom: true
    })
  })

  test('cardio gets the cardiovascular pseudo-muscle; names are unique across the whole library', async () => {
    const r = await h.call('upsert_custom_exercise', { name: 'Hill sprints', body_part: 'cardio', equipment: 'body weight' })
    expect(custom(r.exercise_id).primaries).toEqual(['cardiovascular system'])
    await expect(h.call('upsert_custom_exercise', { name: 'HILL SPRINTS', body_part: 'cardio', equipment: 'body weight' })).rejects.toMatchObject({ code: 'EEXISTS' })
    await expect(h.call('upsert_custom_exercise', { name: 'barbell bench press', body_part: 'chest', equipment: 'barbell' })).rejects.toMatchObject({ code: 'EEXISTS' })
  })

  test('an edit keeps the id and the target while it is still a primary', async () => {
    const r = await h.call('upsert_custom_exercise', { name: 'Thing', body_part: 'back', equipment: 'cable', primary_muscles: ['upper-back', 'biceps'] })
    await h.call('upsert_custom_exercise', { exercise_id: r.exercise_id, name: 'Thing 2', body_part: 'back', equipment: 'cable', primary_muscles: ['biceps', 'upper-back'] })
    expect(custom(r.exercise_id)).toMatchObject({ n: 'Thing 2', tg: 'upper-back' })
    expect(h.srv.state.customEx.filter(c => c.id === r.exercise_id)).toHaveLength(1)
  })
})

describe('upsert_custom_exercise — an edit changes only what it is given', () => {
  test('a rename keeps the description, the target and the muscles', async () => {
    const r = await h.call('upsert_custom_exercise', { name: 'Pendlay Variant', body_part: 'back', equipment: 'barbell', primary_muscles: ['upper-back', 'lower-back'], secondary_muscles: ['biceps'], description: 'dead stop' })
    const before = { ...custom(r.exercise_id) }
    await h.call('upsert_custom_exercise', { exercise_id: r.exercise_id, name: 'Pendlay Row (mine)' })
    expect(custom(r.exercise_id)).toEqual({ ...before, n: 'Pendlay Row (mine)' })
  })

  test('a new one needs its name, body part and equipment', async () => {
    await expect(h.call('upsert_custom_exercise', { name: 'Half' })).rejects.toMatchObject({ code: 'EINVALID' })
  })

  test("search_exercises shows a custom exercise's fields, so it can be edited back", async () => {
    const r = await h.call('upsert_custom_exercise', { name: 'Seal Row Special', body_part: 'back', equipment: 'barbell', primary_muscles: ['upper-back'], description: 'chest on pad' })
    _seedStateForTests(h.srv.state)
    const found = (await h.call('search_exercises', { query: 'seal row special' })).exercises[0]
    expect(found).toMatchObject({ id: r.exercise_id, primary_muscles: ['upper-back'], description: 'chest on pad' })
  })
})

describe('delete_custom_exercise', () => {
  test('cascades like the app: out of routines, weights, favourites; history keeps its name', async () => {
    const c = await h.call('upsert_custom_exercise', { name: 'Zottman Curl Variant', body_part: 'upper arms', equipment: 'dumbbell', primary_muscles: ['biceps'] })
    const id = c.exercise_id
    const routine = await h.call('create_routine', { name: 'Arms', exercises: [{ id, superset_group: 'A' }, { id: '0025', superset_group: 'A' }] })
    await h.call('set_favourite', { exercise_id: id, favourite: true })
    h.srv.state.exWeights[id] = { w: 12, d: '2026-01-01' }
    h.srv.state.workouts.push({ id: 'wx', d: '2026-01-02', start: 1, entries: [{ id, sets: [{ w: 12, r: 10, done: true }] }] })
    await h.call('delete_custom_exercise', { exercise_id: id })
    expect(custom(id)).toBeUndefined()
    const r = h.srv.state.routines.find(x => x.id === routine.routine_id)
    expect(r.ex.map(e => e.id)).toEqual(['0025'])
    expect(r.ex[0].sg).toBeUndefined()
    expect(h.srv.state.exWeights[id]).toBeUndefined()
    expect(h.srv.state.favEx).not.toContain(id)
    const kept = h.srv.state.workouts.find(w => w.id === 'wx').entries[0]
    expect(kept.n).toBe('Zottman Curl Variant')
    expect(kept.muscleSnapshot).toBeTruthy()
  })

  test('once deleted, it is gone for every other tool too', async () => {
    const c = await h.call('upsert_custom_exercise', { name: 'Gone Soon', body_part: 'chest', equipment: 'dumbbell' })
    await h.call('delete_custom_exercise', { exercise_id: c.exercise_id })
    await expect(h.call('set_favourite', { exercise_id: c.exercise_id, favourite: true })).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(h.call('set_exercise_note', { exercise_id: c.exercise_id, note: 'x' })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('only custom exercises', async () => {
    await expect(h.call('delete_custom_exercise', { exercise_id: 'cNope' })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(() => h.call('delete_custom_exercise', { exercise_id: '0025' })).toThrow()
  })
})

describe('notes, favourites, bar weights', () => {
  test('a note is set, trimmed, and removed when empty', async () => {
    await h.call('set_exercise_note', { exercise_id: '0025', note: '  seat 4  ' })
    expect(h.srv.state.exNotes['0025']).toBe('seat 4')
    await h.call('set_exercise_note', { exercise_id: '0025', note: '' })
    expect('0025' in h.srv.state.exNotes).toBe(false)
  })

  test('favourites are a set; unknown exercises are refused', async () => {
    await h.call('set_favourite', { exercise_id: '0025', favourite: true })
    const again = await h.call('set_favourite', { exercise_id: '0025', favourite: true })
    expect(again.changed).toBe(false)
    expect(h.srv.state.favEx.filter(x => x === '0025')).toHaveLength(1)
    await h.call('set_favourite', { exercise_id: '0025', favourite: false })
    expect(h.srv.state.favEx).not.toContain('0025')
    await expect(h.call('set_favourite', { exercise_id: 'nope', favourite: true })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('bar weight: a value, 0 for no bar, null for the default', async () => {
    await h.call('set_bar_weight', { exercise_id: '0025', bar_weight: 15.004 })
    expect(h.srv.state.barWeights['0025']).toBe(15)
    await h.call('set_bar_weight', { exercise_id: '0025', bar_weight: 0 })
    expect(h.srv.state.barWeights['0025']).toBe(0)
    await h.call('set_bar_weight', { exercise_id: '0025', bar_weight: null })
    expect('0025' in h.srv.state.barWeights).toBe(false)
  })
})
