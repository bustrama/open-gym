import { describe, it, expect, vi, beforeEach } from 'vitest'

// The Android app's rest notifications: the countdown (the RestTimer plugin) and the alert at
// the end (a local notification). Capacitor is mocked; what is pinned is what gets posted,
// scheduled and cancelled, and in which order.
const mocks = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(),
  createChannel: vi.fn(), cancel: vi.fn(), schedule: vi.fn(),
  checkPermissions: vi.fn(), requestPermissions: vi.fn(),
  android: true,
}))
vi.mock('./mobile.js', () => ({ MOBILE: true, isAndroid: async () => mocks.android }))
vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({ start: mocks.start, stop: mocks.stop }) }))
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: {
  createChannel: mocks.createChannel, cancel: mocks.cancel, schedule: mocks.schedule,
  checkPermissions: mocks.checkPermissions, requestPermissions: mocks.requestPermissions,
} }))

import { showRest, clearRest, restText, allowRestNotify, REST_ALERT_ID } from './rest-notify.js'

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
    expect(mocks.schedule).not.toHaveBeenCalled()
  })

  it('does nothing off Android', async () => {
    mocks.android = false
    await showRest(ON, { endsAt: ENDS })
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('posts the countdown and schedules the alert for the end of the rest', async () => {
    await showRest(ON, { endsAt: ENDS, text: 'Bench Press' })
    expect(mocks.start).toHaveBeenCalledWith({ endsAt: ENDS, title: 'Rest', text: 'Bench Press', channelName: 'Rest timer' })
    const [{ notifications: [alert] }] = mocks.schedule.mock.calls[0]
    expect(alert).toMatchObject({ id: REST_ALERT_ID, title: 'Rest over — next set!', body: 'Bench Press', channelId: 'rest-over', smallIcon: 'ic_stat_opengym' })
    expect(alert.schedule).toEqual({ at: new Date(ENDS), allowWhileIdle: true })
  })

  it('replaces the alert when the rest changes', async () => {
    await showRest(ON, { endsAt: ENDS })
    await showRest(ON, { endsAt: ENDS + 15000 })
    expect(mocks.cancel).toHaveBeenCalledWith({ notifications: [{ id: REST_ALERT_ID }] })
    expect(mocks.schedule.mock.calls[1][0].notifications[0].schedule.at).toEqual(new Date(ENDS + 15000))
  })

  it('creates the alert channel, one that sounds and vibrates, once', async () => {
    vi.resetModules()
    const fresh = await import('./rest-notify.js')
    await fresh.showRest(ON, { endsAt: ENDS })
    await fresh.showRest(ON, { endsAt: ENDS + 15000 })
    expect(mocks.createChannel).toHaveBeenCalledTimes(1)
    expect(mocks.createChannel).toHaveBeenCalledWith(expect.objectContaining({ id: 'rest-over', importance: 5, vibration: true }))
  })

  it('never lets a failing plugin reach the workout', async () => {
    mocks.start.mockRejectedValue(new Error('not implemented'))
    await expect(showRest(ON, { endsAt: ENDS })).resolves.toBeUndefined()
  })
})

describe('clearRest', () => {
  it('removes the countdown and cancels the alert', async () => {
    await clearRest()
    expect(mocks.stop).toHaveBeenCalled()
    expect(mocks.cancel).toHaveBeenCalledWith({ notifications: [{ id: REST_ALERT_ID }] })
  })

  it('keeps the alert for a rest that ran out unwatched', async () => {
    await clearRest({ keepAlert: true })
    expect(mocks.stop).toHaveBeenCalled()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('runs after a rest still being posted, so a skip never leaves its alert behind', async () => {
    let release
    mocks.start.mockImplementation(() => new Promise(r => { release = r }))
    const shown = showRest(ON, { endsAt: ENDS })
    const cleared = clearRest()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release({})
    await Promise.all([shown, cleared])
    const lastCancel = Math.max(...mocks.cancel.mock.invocationCallOrder)
    expect(lastCancel).toBeGreaterThan(mocks.schedule.mock.invocationCallOrder[0])
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
