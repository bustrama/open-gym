import { describe, it, expect, vi, beforeEach } from 'vitest'

// The Android app's rest notifications: the countdown with its buttons and the alert at the end,
// both posted by the RestTimer plugin. Capacitor is mocked; what is pinned is what gets posted
// and cancelled, in which order, and how a tap on a button reaches the app.
const mocks = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), status: vi.fn(), addListener: vi.fn(),
  checkPermissions: vi.fn(), requestPermissions: vi.fn(),
  android: true,
}))
vi.mock('./mobile.js', () => ({ MOBILE: true, isAndroid: async () => mocks.android }))
vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({ start: mocks.start, stop: mocks.stop, status: mocks.status, addListener: mocks.addListener }) }))
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: {
  checkPermissions: mocks.checkPermissions, requestPermissions: mocks.requestPermissions,
} }))

import { showRest, clearRest, restText, allowRestNotify, restProblem, testRest } from './rest-notify.js'

const ON = { restNotify: true }
const ENDS = Date.UTC(2026, 8, 27, 18, 0, 0)

beforeEach(() => {
  for (const fn of Object.values(mocks)) if (typeof fn === 'function') fn.mockReset().mockResolvedValue({})
  mocks.android = true
})

describe('showRest', () => {
  it('does nothing with the switch off', async () => {
    await showRest({ restNotify: false }, { endsAt: ENDS })
    await showRest(undefined, { endsAt: ENDS })
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('does nothing off Android', async () => {
    mocks.android = false
    await showRest(ON, { endsAt: ENDS })
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('posts the countdown, its buttons and the alert at the end, all in the app language', async () => {
    await showRest(ON, { endsAt: ENDS, text: 'Bench Press', key: 'r1' })
    expect(mocks.start).toHaveBeenCalledWith({
      key: 'r1', endsAt: ENDS, title: 'Rest', text: 'Bench Press', channelName: 'Rest timer',
      alertTitle: 'Rest over — next set!', alertText: 'Bench Press', alertChannelName: 'Rest over',
      step: 15, lessLabel: '−15s', moreLabel: '+15s', skipLabel: 'Skip',
    })
  })

  it('posts again when the rest changes: the plugin replaces countdown and alert', async () => {
    await showRest(ON, { endsAt: ENDS, key: 'r1' })
    await showRest(ON, { endsAt: ENDS + 15000, key: 'r1' })
    expect(mocks.start).toHaveBeenCalledTimes(2)
    expect(mocks.start.mock.calls[1][0]).toMatchObject({ key: 'r1', endsAt: ENDS + 15000 })
  })

  it('answers with what the plugin says', async () => {
    mocks.start.mockResolvedValue({ shown: true })
    expect(await showRest(ON, { endsAt: ENDS })).toEqual({ shown: true })
    mocks.start.mockResolvedValue({ shown: false, reason: 'notifications-off' })
    expect(await showRest(ON, { endsAt: ENDS })).toEqual({ shown: false, reason: 'notifications-off' })
    mocks.start.mockResolvedValue({ shown: true, alertError: 'no alarm' })
    expect(await showRest(ON, { endsAt: ENDS })).toEqual({ shown: true, alertError: 'no alarm' })
  })

  it('answers null where nothing ran', async () => {
    expect(await showRest({ restNotify: false }, { endsAt: ENDS })).toBeNull()
    mocks.android = false
    expect(await showRest(ON, { endsAt: ENDS })).toBeNull()
  })

  it('never lets a failing plugin reach the workout, yet says what failed', async () => {
    mocks.start.mockRejectedValue(new Error('not implemented'))
    await expect(showRest(ON, { endsAt: ENDS })).resolves.toEqual({ shown: false, reason: 'not implemented' })
  })

  it('keeps the queue going after a failure', async () => {
    mocks.start.mockRejectedValueOnce(new Error('boom'))
    await showRest(ON, { endsAt: ENDS })
    await clearRest()
    expect(mocks.stop).toHaveBeenCalled()
  })
})

describe('the countdown buttons', () => {
  it('reach the app through onRestChange, from one listener however many calls race to add it', async () => {
    vi.resetModules()
    const fresh = await import('./rest-notify.js')
    const heard = vi.fn()
    fresh.onRestChange(heard)
    await Promise.all([fresh.showRest(ON, { endsAt: ENDS }), fresh.showRest(ON, { endsAt: ENDS + 15000 }), fresh.clearRest(), fresh.allowRestNotify()])
    expect(mocks.addListener).toHaveBeenCalledTimes(1)
    const [event, relay] = mocks.addListener.mock.calls[0]
    expect(event).toBe('restChange')
    relay({ key: 'r1', skipped: true })
    expect(heard).toHaveBeenCalledWith({ key: 'r1', skipped: true })
  })

  it('go nowhere, quietly, before anyone listens', async () => {
    vi.resetModules()
    const fresh = await import('./rest-notify.js')
    await fresh.showRest(ON, { endsAt: ENDS })
    expect(() => mocks.addListener.mock.calls[0][1]({ key: 'r1', skipped: true })).not.toThrow()
  })

  it('cannot take the rest down when their listener cannot be added', async () => {
    vi.resetModules()
    mocks.addListener.mockRejectedValue(new Error('no events'))
    mocks.start.mockResolvedValue({ shown: true })
    const fresh = await import('./rest-notify.js')
    expect(await fresh.showRest(ON, { endsAt: ENDS })).toEqual({ shown: true })
  })
})

describe('restProblem', () => {
  it('has nothing to say about a countdown that shows, a rest already over, or nothing run', () => {
    expect(restProblem({ shown: true })).toBeNull()
    expect(restProblem({ shown: false, reason: 'over' })).toBeNull()
    expect(restProblem(null)).toBeNull()
  })

  it('sends the user to Android settings when notifications are off there', () => {
    expect(restProblem({ shown: false, reason: 'notifications-off' })).toBe('Rest timer notifications are turned off in Android settings.')
    expect(restProblem({ shown: false, reason: 'channel-off' })).toBe('Rest timer notifications are turned off in Android settings.')
  })

  it('names any other failure, the alert included', () => {
    expect(restProblem({ shown: false, reason: 'not implemented' })).toBe('The rest timer could not be shown (not implemented).')
    expect(restProblem({ shown: true, alertError: 'no alarm' })).toBe('The rest timer could not be shown (no alarm).')
  })
})

describe('testRest', () => {
  it('posts a 10-second rest even with the switch off, then asks Android what is up', async () => {
    mocks.start.mockResolvedValue({ shown: true })
    mocks.status.mockResolvedValue({ enabled: true, channel: 3, active: true, sdk: 36 })
    const r = await testRest({ restNotify: false }, { settle: 0 })
    expect(mocks.start.mock.calls[0][0].endsAt).toBeGreaterThan(Date.now() + 9000)
    expect(r).toEqual({ shown: true, status: { enabled: true, channel: 3, active: true, sdk: 36 } })
  })

  it('reports a countdown that was posted but is not up', async () => {
    mocks.start.mockResolvedValue({ shown: true })
    mocks.status.mockResolvedValue({ enabled: true, channel: 3, active: false, sdk: 36 })
    const r = await testRest({}, { settle: 0 })
    expect(r.shown).toBe(false)
    expect(r.reason).toBe('not showing: notifications on, channel 3, SDK 36')
  })

  it('passes a refusal straight on', async () => {
    mocks.start.mockResolvedValue({ shown: false, reason: 'channel-off' })
    expect(await testRest({}, { settle: 0 })).toEqual({ shown: false, reason: 'channel-off' })
    expect(mocks.status).not.toHaveBeenCalled()
  })
})

describe('clearRest', () => {
  it('removes the countdown and cancels the alert', async () => {
    await clearRest()
    expect(mocks.stop).toHaveBeenCalledWith({ keepAlert: false })
  })

  it('keeps the alert for a rest that ran out unwatched', async () => {
    await clearRest({ keepAlert: true })
    expect(mocks.stop).toHaveBeenCalledWith({ keepAlert: true })
  })

  it('runs after a rest still being posted, so a skip never leaves its alert behind', async () => {
    let release
    mocks.start.mockImplementation(() => new Promise(r => { release = r }))
    const shown = showRest(ON, { endsAt: ENDS })
    const cleared = clearRest()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(mocks.stop).not.toHaveBeenCalled()
    release({})
    await Promise.all([shown, cleared])
    expect(mocks.stop.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.start.mock.invocationCallOrder[0])
  })
})

describe('restText', () => {
  const set = done => ({ w: 60, r: 8, done })
  const active = {
    entries: [
      { id: '0025', sets: [set(true), set(false)] },
      { id: '0739', sets: [set(false)] },
    ],
  }

  it('names the exercise the rest is between sets of', () => {
    expect(restText(active, 0)).toMatch(/^[A-Z]/)
    expect(restText(active, 0)).not.toMatch(/^Up next/)
  })

  it('names the next exercise once this one is finished', () => {
    const finished = { entries: [{ ...active.entries[0], sets: [set(true)] }, active.entries[1]] }
    expect(restText(finished, 0)).toBe('Up next: Sled 45° Leg Press')
  })

  it('says nothing when it cannot tell', () => {
    expect(restText(active, undefined)).toBe('')
    expect(restText(null, 0)).toBe('')
  })
})

describe('allowRestNotify', () => {
  it('asks only when the permission is not there yet', async () => {
    mocks.checkPermissions.mockResolvedValue({ display: 'granted' })
    expect(await allowRestNotify()).toBe(true)
    expect(mocks.requestPermissions).not.toHaveBeenCalled()
  })

  it('reports a refusal', async () => {
    mocks.checkPermissions.mockResolvedValue({ display: 'prompt' })
    mocks.requestPermissions.mockResolvedValue({ display: 'denied' })
    expect(await allowRestNotify()).toBe(false)
  })
})
