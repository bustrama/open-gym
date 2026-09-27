import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

// public/sw.js is a plain worker script, not a module: it runs here against a stand-in `self`
// that records its listeners, with the push manager and fetch mocked.
const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')

let listeners, fetchMock, pushManager
const bootWorker = () => {
  listeners = {}
  fetchMock = vi.fn(async () => ({ ok: true }))
  pushManager = { getSubscription: vi.fn(async () => null), subscribe: vi.fn() }
  const self = { addEventListener: (type, fn) => { listeners[type] = fn }, registration: { pushManager } }
  new Function('self', 'fetch', 'caches', 'location', source)(self, fetchMock, {}, { origin: 'https://gym.test' })
}
const fire = async (type, event) => {
  let work
  listeners[type]({ ...event, waitUntil: p => { work = p } })
  await work
}
const sub = endpoint => ({ endpoint, options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer }, toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }) })
const sent = () => JSON.parse(fetchMock.mock.calls[0][1].body)

beforeEach(bootWorker)

describe('pushsubscriptionchange', () => {
  it('registers the new subscription and names the endpoint it replaces, so the server keeps the device id', async () => {
    await fire('pushsubscriptionchange', { oldSubscription: sub('https://push.example/old'), newSubscription: sub('https://push.example/new') })
    expect(fetchMock).toHaveBeenCalledWith('api/push/subscribe', expect.objectContaining({ method: 'POST' }))
    expect(sent()).toEqual({ subscription: { endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } }, oldEndpoint: 'https://push.example/old' })
  })

  it('subscribes again with the old key when the browser hands over no new subscription', async () => {
    const old = sub('https://push.example/old')
    pushManager.subscribe.mockResolvedValue(sub('https://push.example/new'))
    await fire('pushsubscriptionchange', { oldSubscription: old, newSubscription: null })
    expect(pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: old.options.applicationServerKey })
    expect(sent().oldEndpoint).toBe('https://push.example/old')
  })

  it('names no old endpoint when it only knows the current one', async () => {
    const same = sub('https://push.example/same')
    pushManager.getSubscription.mockResolvedValue(same)
    pushManager.subscribe.mockResolvedValue(same)
    await fire('pushsubscriptionchange', { oldSubscription: null, newSubscription: null })
    expect(sent()).toEqual({ subscription: { endpoint: 'https://push.example/same', keys: { p256dh: 'p', auth: 'a' } } })
  })

  it('does nothing without a key to subscribe with', async () => {
    await fire('pushsubscriptionchange', { oldSubscription: null, newSubscription: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
