// @vitest-environment happy-dom
// The Android app's rest notifications follow the rest timer: posted when a rest starts,
// replaced when time is added, cleared when it ends. A rest that runs out unwatched keeps its
// alert, which is then the only thing telling anyone; one that runs out on screen already beeped.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

const phone = vi.hoisted(() => ({
  showRest: vi.fn(), clearRest: vi.fn(), restText: vi.fn(() => 'Bench Press'),
  restProblem: vi.fn(r => (r && r.shown === false ? `problem: ${r.reason}` : null)),
}))
vi.mock('../lib/rest-notify.js', () => phone)

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
  for (const fn of Object.values(phone)) fn.mockClear()
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
    expect(phone.showRest).toHaveBeenCalledWith(expect.objectContaining({ restNotify: true }), { endsAt: Date.now() + 90000, text: 'Bench Press' })
    expect(phone.restText).toHaveBeenCalledWith(useStore.getState().S.active, 0)
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
