import { describe, test, expect } from 'vitest'
import { normalizeExConfig } from './ex-config.js'
import { EXDB, isCardio, isBodyweightEq } from './exercises.js'
import { defaultConfig } from './history.js'

// Real dataset ids, found by property rather than hard-coded, so a dataset refresh cannot
// quietly turn the barbell lift into a cardio machine under these tests.
const barbell = EXDB.find(e => !isCardio(e.id) && !isBodyweightEq(e.id) && e.eq === 'barbell').id
const bodyweight = EXDB.find(e => !isCardio(e.id) && isBodyweightEq(e.id)).id
const cardio = EXDB.find(e => isCardio(e.id)).id
const routine = { id: 'r1', name: 'A', ex: [] }

describe('normalizeExConfig — the routine editor\'s save, as a pure function', () => {
  test('an untouched default saves as the default the editor starts from', () => {
    expect(normalizeExConfig({ id: barbell, ...defaultConfig(barbell) }, routine)).toEqual({ id: barbell, ...defaultConfig(barbell) })
    expect(normalizeExConfig({ id: cardio, ...defaultConfig(cardio) }, routine)).toEqual({ id: cardio, ...defaultConfig(cardio) })
  })

  test('missing fields take the sheet\'s defaults; sets and reps are whole and at least 1', () => {
    expect(normalizeExConfig({ id: barbell }, routine)).toEqual({ id: barbell, sets: 3, mode: 'reps', reps: 10, weight: 0 })
    // 0 (or a fraction that rounds to it) means "not set" and takes the default; a negative
    // is a number, clamped to the floor — exactly `Math.max(1, Math.round(x) || default)`.
    expect(normalizeExConfig({ id: barbell, sets: 0.4, reps: -3, weight: -5 }, routine)).toMatchObject({ sets: 3, reps: 1, weight: 0 })
    expect(normalizeExConfig({ id: barbell, sets: 4.6, reps: 7.4, weight: 62.5 }, routine)).toMatchObject({ sets: 5, reps: 7, weight: 62.5 })
  })

  test('cardio keeps only its own fields — no mode, no weight, no progression', () => {
    const c = normalizeExConfig({ id: cardio, sets: 2, min: 25, speed: 10.5, weight: 40, prog: 'linear', restSec: 60 }, routine)
    expect(c).toEqual({ id: cardio, sets: 2, min: 25, speed: 10.5, restSec: 60 })
  })

  test('a timed hold drops `side`, keeps its own sec and flags', () => {
    const c = normalizeExConfig({ id: bodyweight, mode: 'time', sec: 60, side: true, sets: 3 }, routine)
    expect(c).toEqual({ id: bodyweight, sets: 3, mode: 'time', sec: 60, weight: 0 })
    expect(c.side).toBeUndefined()
  })

  test('per side: an odd target is rounded up to an even total', () => {
    expect(normalizeExConfig({ id: barbell, reps: 15, side: true }, routine)).toMatchObject({ reps: 16, side: true })
  })

  test('double progression stores a normalized range; the lower bound is written', () => {
    const c = normalizeExConfig({ id: barbell, prog: 'double', reps: 12, repsMin: 8 }, routine)
    expect(c).toMatchObject({ mode: 'reps', prog: 'double', reps: 12, repsMin: 8 })
    const inverted = normalizeExConfig({ id: barbell, prog: 'double', reps: 6, repsMin: 10 }, routine)
    expect(inverted.repsMin).toBeLessThan(inverted.reps)
  })

  test('a routine rule is inherited: double on the routine makes a range without a per-exercise prog', () => {
    const c = normalizeExConfig({ id: barbell, reps: 10 }, { ...routine, prog: 'double' })
    expect(c.prog).toBeUndefined()
    expect(c.repsMin).toBeDefined()
  })

  test('the 90% deload is omitted; any other is clamped to 50-95% and written', () => {
    expect(normalizeExConfig({ id: barbell, deloadFactor: 0.9 }, routine).deloadFactor).toBeUndefined()
    expect(normalizeExConfig({ id: barbell, deloadFactor: 0.8 }, routine).deloadFactor).toBe(0.8)
    expect(normalizeExConfig({ id: barbell, deloadFactor: 0.2 }, routine).deloadFactor).toBe(0.5)
    expect(normalizeExConfig({ id: barbell, deloadFactor: 0.8, prog: 'off' }, routine).deloadFactor).toBeUndefined()
  })

  test('the bodyweight flag is written only when it differs from the dataset', () => {
    expect(normalizeExConfig({ id: bodyweight }, routine).bodyweight).toBeUndefined()
    expect(normalizeExConfig({ id: bodyweight, bodyweight: false }, routine).bodyweight).toBe(false)
    expect(normalizeExConfig({ id: barbell, bodyweight: true }, routine).bodyweight).toBe(true)
  })

  test('a rep ceiling only for unloaded bodyweight work, and never below the working reps', () => {
    expect(normalizeExConfig({ id: bodyweight, reps: 10, repsMax: 6 }, routine).repsMax).toBe(10)
    expect(normalizeExConfig({ id: bodyweight, reps: 10, repsMax: 15 }, routine).repsMax).toBe(15)
    expect(normalizeExConfig({ id: bodyweight, reps: 10, repsMax: 15, weight: 10 }, routine).repsMax).toBeUndefined()
    expect(normalizeExConfig({ id: barbell, reps: 10, repsMax: 15 }, routine).repsMax).toBeUndefined()
  })

  test('note, warm-ups and rest are written only when set, and clamped', () => {
    const c = normalizeExConfig({ id: barbell, note: '  seat 4  ', warmupSets: 9, restSec: 150.4 }, routine)
    expect(c).toMatchObject({ note: 'seat 4', warmupSets: 5, restSec: 150 })
    const bare = normalizeExConfig({ id: barbell, note: '   ', warmupSets: 0, restSec: 0 }, routine)
    expect(bare.note).toBeUndefined()
    expect(bare.warmupSets).toBeUndefined()
    expect(bare.restSec).toBeUndefined()
    expect(normalizeExConfig({ id: barbell, note: 'x'.repeat(600) }, routine).note).toHaveLength(500)
  })

  test('intensifiers: drop set and rest-pause, clamped; anything else is dropped', () => {
    expect(normalizeExConfig({ id: barbell, intensifier: { type: 'dropset', count: 2, pct: 20 } }, routine).intensifier)
      .toEqual({ type: 'dropset', count: 2, pct: 20 })
    expect(normalizeExConfig({ id: barbell, intensifier: { type: 'restpause', totalReps: 20, restSec: 2 } }, routine).intensifier)
      .toEqual({ type: 'restpause', totalReps: 20, restSec: 5 })
    expect(normalizeExConfig({ id: barbell, intensifier: { type: 'superslow' } }, routine).intensifier).toBeUndefined()
  })

  test('the superset link is never part of an exercise config', () => {
    expect(normalizeExConfig({ id: barbell, sg: 'sgabc' }, routine).sg).toBeUndefined()
  })
})
