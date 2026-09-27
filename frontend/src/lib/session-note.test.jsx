// @vitest-environment happy-dom
// The session note shipped with a hole in it: buildCompletedWorkout read `active.note` and
// nothing in the app ever wrote it, so the only way to get one was after the fact — and that
// path threw the text away unless you happened to tab out of the field first.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { sessionNoteSheet, workoutDetailSheet, finishWorkout, workoutCompleteSheet } from '../sheets.jsx'
import { buildCompletedWorkout } from './finish-workout.js'

const mounted = []
function render(open) {
  open()
  const sheet = useUI.getState().sheets.at(-1)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return host
}
const type = (el, value) => {
  Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const unmountAll = () => act(() => { mounted.splice(0).forEach(r => r.unmount()) })

const workout = () => ({
  id: 'w1', d: '2026-08-25', start: 1, end: 2, name: 'Push', vol: 100,
  entries: [{ id: 'bench', sets: [{ w: 100, r: 5, done: true }] }], prs: [],
})

describe('session note', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useUI.setState({ sheets: [] })
    document.body.innerHTML = ''
  })
  afterEach(unmountAll)

  it('can be written during the workout and survives finishing', () => {
    useStore.setState(s => ({
      S: { ...s.S, active: { id: 'w1', d: '2026-08-25', start: 1, name: 'Push', entries: [{ id: 'bench', sets: [] }] } },
    }))
    const host = render(() => sessionNoteSheet())
    act(() => { type(host.querySelector('textarea'), 'slept badly, still hit it') })
    act(() => { [...host.querySelectorAll('button')].find(b => /save/i.test(b.textContent)).click() })

    const A = useStore.getState().S.active
    expect(A.note).toBe('slept badly, still hit it')
    // The path buildCompletedWorkout already had a test for is now actually reachable.
    expect(buildCompletedWorkout(A, { end: 2 }).note).toBe('slept badly, still hit it')
  })

  it('is kept when the history sheet is dismissed without blurring the field', () => {
    useStore.setState(s => ({ S: { ...s.S, workouts: [workout()] } }))
    const host = render(() => workoutDetailSheet(useStore.getState().S.workouts[0]))
    act(() => { type(host.querySelector('textarea'), 'good session') })
    // Escape / Android back / swipe all unmount without a blur.
    unmountAll()
    expect(useStore.getState().S.workouts[0].note).toBe('good session')
  })

  it('clearing it removes the note rather than storing an empty string', () => {
    useStore.setState(s => ({ S: { ...s.S, workouts: [{ ...workout(), note: 'old' }] } }))
    const host = render(() => workoutDetailSheet(useStore.getState().S.workouts[0]))
    act(() => { type(host.querySelector('textarea'), '   ') })
    unmountAll()
    expect(useStore.getState().S.workouts[0].note).toBeUndefined()
  })
})

// The last chance to say how it went is at the finish itself, not a separate button above it.
describe('session note at the finish', () => {
  const active = (sets, note) => ({
    id: 'w-fin', d: '2026-08-25', start: Date.now() - 3600_000, name: 'Push', routineIds: [],
    entries: [{ id: 'bench', target: { mode: 'reps', reps: 5 }, sets }],
    ...(note ? { note } : {}),
  })
  const button = (host, re) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent))

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useUI.setState({ sheets: [] })
    useStore.setState(s => ({ S: { ...s.S, sound: false, workouts: [] } }))
    document.body.innerHTML = ''
  })
  afterEach(() => { unmountAll(); useUI.setState({ sheets: [] }) })

  it('asks for it with what was written during the workout, and files it with the workout', () => {
    useStore.setState(s => ({ S: { ...s.S, active: active([{ w: 100, r: 5, done: true }], 'warm gym') } }))
    const host = render(() => finishWorkout())
    const area = host.querySelector('textarea')
    expect(area.value).toBe('warm gym')
    act(() => { type(area, 'warm gym, bench moved fast') })
    act(() => { button(host, /finish workout/i).click() })

    expect(useStore.getState().S.active).toBeNull()
    expect(useStore.getState().S.workouts.at(-1).note).toBe('warm gym, bench moved fast')
  })

  it('says how many sets are still open when finishing early', () => {
    useStore.setState(s => ({ S: { ...s.S, active: active([{ w: 100, r: 5, done: true }, { w: 100, r: 5, done: false }]) } }))
    const host = render(() => finishWorkout())
    expect(host.textContent).toMatch(/Finish early\?/)
    expect(host.textContent).toMatch(/1 set still unchecked/)
  })

  it('keeps the note when you go back to training, and does not finish', () => {
    useStore.setState(s => ({ S: { ...s.S, active: active([{ w: 100, r: 5, done: true }]) } }))
    const host = render(() => workoutCompleteSheet())
    act(() => { type(host.querySelector('textarea'), 'one more set of dips') })
    act(() => { button(host, /continue workout/i).click() })

    expect(useStore.getState().S.active.note).toBe('one more set of dips')
    expect(useStore.getState().S.workouts).toHaveLength(0)
  })

  it('keeps the note when the sheet is swiped away', () => {
    useStore.setState(s => ({ S: { ...s.S, active: active([{ w: 100, r: 5, done: true }]) } }))
    const host = render(() => finishWorkout())
    act(() => { type(host.querySelector('textarea'), 'short on time') })
    unmountAll()
    expect(useStore.getState().S.active.note).toBe('short on time')
  })
})
