// @vitest-environment happy-dom
// The Android app's rest notifications follow the rest timer: posted when a rest starts,
// replaced when time is added, cleared when it ends. A rest that runs out unwatched keeps its
// alert, which is then the only thing telling anyone; one that runs out on screen already beeped.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

const phone = vi.hoisted(() => ({
  showRest: vi.fn(), clearRest: vi.fn(), restText: vi.fn(() => 'Bench Press'),
  restProblem: vi.fn(r => (r && r.shown === false ? `problem: ${r.reason}` : null)),
  // useUI hands over its handler for the countdown's buttons at import; `tap` plays the phone.
  onRestChange: vi.fn(fn => { phone.tap = fn }),
  tap: null,
}))
vi.mock('../lib/rest-notify.js', () => phone)
const api = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('../lib/api.js', () => ({ api }))

import { useUI } from './useUI.js'
import { useStore } from './useStore.js'

const hide = hidden => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' })
  document.dispatchEvent(new Event('visibilitychange'))
}

let originalS
beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-27T18:00:00Z') })
  originalS = useStore.getState().S
  useStore.setState({ S: { ...originalS, sound: false, restNotify: true }, user: null })
  useUI.setState({ timer: null })
  hide(false)
  for (const fn of Object.values(phone)) if (typeof fn === 'function' && fn.mockClear && fn !== phone.onRestChange) fn.mockClear()
  api.mockClear()
})
afterEach(() => {
  useUI.getState().stopRest()
  hide(false)
  useStore.setState({ S: originalS })
  vi.useRealTimers()
})

describe('the phone follows the rest', () => {
  it('posts the countdown and the alert when a rest starts', () => {
    useUI.getState().startRest(90, 0, 1)
    const { key } = useUI.getState().timer
    expect(key).toEqual(expect.any(String))
    expect(phone.showRest).toHaveBeenCalledWith(expect.objectContaining({ restNotify: true }), { endsAt: Date.now() + 90000, key, text: 'Bench Press' })
    expect(phone.restText).toHaveBeenCalledWith(useStore.getState().S.active, 0)
  })

  it('names every rest apart, and keeps the name when time is added', () => {
    useUI.getState().startRest(90)
    const first = useUI.getState().timer.key
    useUI.getState().addRest(15)
    expect(phone.showRest).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ key: first }))
    useUI.getState().startRest(90)
    expect(useUI.getState().timer.key).not.toBe(first)
  })

  it('posts nothing with the switch off (and on the web, where it is never on)', () => {
    useStore.setState({ S: { ...useStore.getState().S, restNotify: false } })
    useUI.getState().startRest(90, 0, 1)
    useUI.getState().addRest(15)
    expect(phone.showRest).not.toHaveBeenCalled()
  })

  it('moves them when time is added or taken off', () => {
    useUI.getState().startRest(90, 0, 1)
    const endsAt = useUI.getState().timer.endsAt
    useUI.getState().addRest(15)
    expect(phone.showRest).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ endsAt: endsAt + 15000 }))
    useUI.getState().addRest(-30)
    expect(phone.showRest).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ endsAt: endsAt - 15000 }))
  })

  it('clears both on a skip', () => {
    useUI.getState().startRest(90)
    phone.clearRest.mockClear()
    useUI.getState().stopRest()
    expect(phone.clearRest).toHaveBeenCalledWith({ keepAlert: false })
  })

  it('clears nothing when no rest was running', () => {
    useUI.getState().stopRest()
    expect(phone.clearRest).not.toHaveBeenCalled()
  })

  it('keeps the alert for a rest that ran out while the app was hidden', async () => {
    useUI.getState().startRest(2)
    hide(true)
    phone.clearRest.mockClear()
    await vi.advanceTimersByTimeAsync(3000)
    expect(useUI.getState().timer).toBe(null)
    expect(phone.clearRest).toHaveBeenCalledWith({ keepAlert: true })
  })

  it('drops the alert for a rest that ran out on screen, which already beeped', async () => {
    useUI.getState().startRest(2)
    phone.clearRest.mockClear()
    await vi.advanceTimersByTimeAsync(3000)
    expect(useUI.getState().timer).toBe(null)
    expect(phone.clearRest).toHaveBeenCalledWith({ keepAlert: false })
  })

  // The "told once" mark lives as long as the module, a whole app session: no other test here
  // may expect this toast.
  it('says once per session why nothing shows', async () => {
    phone.showRest.mockResolvedValue({ shown: false, reason: 'notifications-off' })
    useUI.getState().startRest(90)
    await vi.waitFor(() => expect(useUI.getState().toastMsg).toBe('problem: notifications-off'))
    useUI.setState({ toastMsg: '' })
    useUI.getState().startRest(90)
    await vi.advanceTimersByTimeAsync(0)
    expect(phone.showRest).toHaveBeenCalledTimes(2)
    expect(useUI.getState().toastMsg).toBe('')
    phone.showRest.mockReset()
  })

  it('does not carry "ran out" over to the next rest', async () => {
    useUI.getState().startRest(2)
    hide(true)
    await vi.advanceTimersByTimeAsync(3000)
    hide(false)
    useUI.getState().startRest(90)
    phone.clearRest.mockClear()
    useUI.getState().stopRest()
    expect(phone.clearRest).toHaveBeenCalledWith({ keepAlert: false })
  })
})

// The phone moved its own countdown and alert already (RestTimer.java); the app follows, and
// never posts the rest back to the phone for it.
describe('the countdown buttons on the phone', () => {
  it('move the rest on screen, and the server push timer with it', () => {
    useStore.setState({ user: { id: 'u1' } })
    useUI.getState().startRest(90, 0, 1)
    const { key, endsAt } = useUI.getState().timer
    phone.showRest.mockClear(); api.mockClear()
    phone.tap({ key, endsAt: endsAt + 15000 })
    expect(useUI.getState().timer).toMatchObject({ key, endsAt: endsAt + 15000, left: 105, total: 105, forIdx: 0, forSet: 1 })
    expect(phone.showRest).not.toHaveBeenCalled()
    const [path, opts] = api.mock.calls[0]
    expect(path).toBe('/api/push/rest-timer')
    expect(JSON.parse(opts.body).seconds).toBe(105)
  })

  it('end the rest on Skip, alert and push timer included', () => {
    useStore.setState({ user: { id: 'u1' } })
    useUI.getState().startRest(90)
    phone.clearRest.mockClear(); api.mockClear()
    phone.tap({ key: useUI.getState().timer.key, skipped: true })
    expect(useUI.getState().timer).toBe(null)
    expect(phone.clearRest).toHaveBeenCalledWith({ keepAlert: false })
    expect(api.mock.calls.map(c => c[0])).toEqual(['/api/push/rest-timer/cancel'])
  })

  it('leave another rest alone', () => {
    useUI.getState().startRest(90)
    const before = useUI.getState().timer
    phone.tap({ key: 'an-older-rest', skipped: true })
    phone.tap({ key: 'an-older-rest', endsAt: before.endsAt + 15000 })
    expect(useUI.getState().timer).toBe(before)
  })

  it('do nothing with no rest running', () => {
    phone.tap({ key: 'whatever', skipped: true })
    expect(useUI.getState().timer).toBe(null)
    expect(phone.clearRest).not.toHaveBeenCalled()
  })

  it('end, quietly, a rest whose new end passed while the app was asleep, keeping its alert', async () => {
    useUI.getState().startRest(30)
    const { key, endsAt } = useUI.getState().timer
    hide(true)
    phone.clearRest.mockClear()
    // −15s tapped at 20 left; the app only hears of it 10 seconds later
    vi.setSystemTime(Date.now() + 20000)
    phone.tap({ key, endsAt: endsAt - 15000 })
    expect(useUI.getState().timer).toBe(null)
    expect(phone.clearRest).toHaveBeenCalledWith({ keepAlert: true })
  })

  it('keep counting down after a change', async () => {
    useUI.getState().startRest(10)
    const { key, endsAt } = useUI.getState().timer
    phone.tap({ key, endsAt: endsAt + 15000 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(useUI.getState().timer.left).toBe(20)
    await vi.advanceTimersByTimeAsync(21000)
    expect(useUI.getState().timer).toBe(null)
  })
})
