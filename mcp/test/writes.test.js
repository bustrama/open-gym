// The write path: tools → writer.commit → a fake api with the real one's revision and 409
// behavior (api/server.js conditionalWrite), seeded from the demo profile. Pins what each tool
// writes (the same fields the app's sheets write), the retry on a phone writing in between, the
// no-op short-circuit, and undo that only takes back its own change.
import { describe, test, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { _seedStateForTests } from '../src/state.js'
import { ConflictError, createApiClient } from '../src/api-client.js'
import { createJournal, diffState, applyUndo } from '../src/journal.js'
import { createWriter } from '../src/writer.js'
import { checkInvariants } from '../src/invariants.js'
import { READ_TOOLS, writeTools, todayFor, zoneFor, zonedEpoch } from '../src/edit-tools.js'

const clone = o => JSON.parse(JSON.stringify(o))

// The api's document store, reduced to what the writer relies on: a revision that must match,
// a 409 carrying the current document, `active` stripped, `_rev` server-owned.
function fakeApi(initial) {
  const srv = { state: clone(initial), rev: 1, writes: 0, interleave: [] }
  const client = {
    async read() { return { state: clone(srv.state), rev: srv.rev } },
    async write(state, baseRev) {
      const other = srv.interleave.shift()          // a phone that writes between our read and write
      if (other) { other(srv.state); srv.rev += 1 }
      if (baseRev !== srv.rev) throw new ConflictError(clone(srv.state), srv.rev)
      const doc = clone(state)
      delete doc.active
      srv.rev += 1
      doc._rev = srv.rev
      srv.state = doc
      srv.writes += 1
      return { rev: srv.rev }
    }
  }
  return { srv, client }
}

let srv, writer, call
function setup(state = buildDemoState()) {
  const api = fakeApi(state)
  srv = api.srv
  writer = createWriter({ client: api.client, journal: createJournal({ dir: null }) })
  _seedStateForTests(clone(state))
  const all = [...READ_TOOLS, ...writeTools(writer)]
  // What the MCP SDK does before a handler runs: parse the arguments against the tool's schema.
  call = (name, params = {}) => {
    const t = all.find(x => x.name === name)
    if (!t) throw new Error(`no tool ${name}`)
    return t.handler(z.object(t.schema).parse(params))
  }
}

beforeEach(() => setup())

const bwOn = d => srv.state.bodyweight.find(b => b.d === d)

describe('log_bodyweight / delete_bodyweight / set_goal_weight', () => {
  test('logs a day the way the weigh-in sheet does: rounded, stamped, sorted', async () => {
    const tsBefore = srv.state._ts || 0
    const r = await call('log_bodyweight', { weight: 80.26, date: '2026-01-02' })
    expect(r.ok).toBe(true)
    expect(r.change_id).toMatch(/^[0-9a-f]{12}$/)
    const e = bwOn('2026-01-02')
    expect(e.w).toBe(80.3)
    expect(typeof e.t).toBe('number')
    const days = srv.state.bodyweight.map(b => b.d)
    expect(days).toEqual([...days].sort())
    expect(srv.state._ts).toBeGreaterThan(tsBefore)
  })

  test('a day that already has a weigh-in is replaced, not duplicated', async () => {
    await call('log_bodyweight', { weight: 80, date: '2026-01-02' })
    await call('log_bodyweight', { weight: 81, date: '2026-01-02' })
    expect(srv.state.bodyweight.filter(b => b.d === '2026-01-02')).toHaveLength(1)
    expect(bwOn('2026-01-02').w).toBe(81)
  })

  test('the same value again writes nothing', async () => {
    await call('log_bodyweight', { weight: 80, date: '2026-01-02' })
    const writes = srv.writes
    const r = await call('log_bodyweight', { weight: 80, date: '2026-01-02' })
    expect(r.changed).toBe(false)
    expect(srv.writes).toBe(writes)
  })

  test('defaults to today in the athlete\'s zone, and refuses the future or a non-date', async () => {
    const r = await call('log_bodyweight', { weight: 79.5 })
    expect(r.date).toBe(todayFor(srv.state))
    await expect(call('log_bodyweight', { weight: 80, date: '2999-01-01' })).rejects.toMatchObject({ code: 'EINVALID' })
    await expect(call('log_bodyweight', { weight: 80, date: '2026-02-30' })).rejects.toMatchObject({ code: 'EINVALID' })
    await expect(call('log_bodyweight', { weight: 80, date: 'yesterday' })).rejects.toMatchObject({ code: 'EINVALID' })
  })

  test('delete removes the day; a day without one is an error', async () => {
    await call('log_bodyweight', { weight: 80, date: '2026-01-02' })
    await call('delete_bodyweight', { date: '2026-01-02' })
    expect(bwOn('2026-01-02')).toBeUndefined()
    await expect(call('delete_bodyweight', { date: '2026-01-02' })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('goal weight is rounded; null removes it', async () => {
    await call('set_goal_weight', { weight: 75.04 })
    expect(srv.state.targetW).toBe(75)
    await call('set_goal_weight', { weight: null })
    expect(srv.state.targetW).toBeNull()
  })
})

describe('set_week_plan / set_day_override', () => {
  const ids = () => srv.state.routines.map(r => r.id)

  test('replace, add and remove on one weekday; a day emptied is deleted, never []', async () => {
    const [a, b] = ids()
    await call('set_week_plan', { weekday: 'wednesday', routine_ids: [a] })
    expect(srv.state.week['3']).toEqual([a])
    await call('set_week_plan', { weekday: 3, routine_ids: [b, a], mode: 'add' })
    expect(srv.state.week['3']).toEqual([a, b])
    const r = await call('set_week_plan', { weekday: 3, routine_ids: [a, b], mode: 'remove' })
    expect('3' in srv.state.week).toBe(false)
    expect(r.week.wednesday).toEqual([])
  })

  test('an unknown routine is refused and nothing is written', async () => {
    const writes = srv.writes
    await expect(call('set_week_plan', { weekday: 1, routine_ids: ['nope'] })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(srv.writes).toBe(writes)
  })

  test('a date override takes a routine, "rest", or null for back-to-plan', async () => {
    const [a] = ids()
    await call('set_day_override', { date: '2026-10-01', routine: a })
    expect(srv.state.dayPlan['2026-10-01']).toBe(a)
    await call('set_day_override', { date: '2026-10-01', routine: 'rest' })
    expect(srv.state.dayPlan['2026-10-01']).toBe('rest')
    await call('set_day_override', { date: '2026-10-01', routine: null })
    expect('2026-10-01' in srv.state.dayPlan).toBe(false)
    await expect(call('set_day_override', { date: '2026-10-01', routine: 'nope' })).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(call('set_day_override', { date: '10/01/2026', routine: 'rest' })).rejects.toMatchObject({ code: 'EINVALID' })
  })
})

describe('settings', () => {
  test('only the given fields change; effort drops the legacy showRir; reminder keeps its zone', async () => {
    srv.state.showRir = true
    srv.state.reminder = { on: false, time: '08:00', tz: 'Asia/Jerusalem' }
    const before = clone(srv.state)
    const r = await call('update_settings', { rest_sec: 120, effort: 'rir', reminder_on: true, reminder_time: '07:30' })
    expect(srv.state.restSec).toBe(120)
    expect(srv.state.effort).toBe('rir')
    expect('showRir' in srv.state).toBe(false)
    expect(srv.state.reminder).toEqual({ on: true, time: '07:30', tz: 'Asia/Jerusalem' })
    expect(srv.state.theme).toBe(before.theme)
    expect(r.settings.rest_sec).toBe(120)
  })

  test('kg/lb is refused with the reason, and a bad value never reaches the handler', async () => {
    await expect(call('update_settings', { unit: 'lb' })).rejects.toMatchObject({ code: 'EREFUSED' })
    expect(() => call('update_settings', { theme: 'neon' })).toThrow()
    expect(() => call('update_settings', { reminder_time: '25:00' })).toThrow()
  })

  test('get_settings reads them back', () => {
    const s = call('get_settings')
    expect(s.unit).toBe('kg')
    expect(s).toHaveProperty('rest_sec')
    expect(s.reminder).toHaveProperty('on')
  })
})

describe('writer: a phone writing in between', () => {
  test('a 409 re-applies the change on top of the other write — both survive, logged once', async () => {
    srv.interleave.push(s => { s.bodyweight.push({ d: '2025-12-31', w: 90, t: 1 }); s.bodyweight.sort((a, b) => (a.d < b.d ? -1 : 1)) })
    const r = await call('log_bodyweight', { weight: 80, date: '2026-01-02' })
    expect(r.ok).toBe(true)
    expect(bwOn('2025-12-31').w).toBe(90)
    expect(bwOn('2026-01-02').w).toBe(80)
    expect(srv.state.bodyweight.filter(b => b.d === '2026-01-02')).toHaveLength(1)
    expect(writer.journal.list(10)).toHaveLength(1)
  })

  test('gives up with ECONFLICT when the document keeps moving', async () => {
    for (let i = 0; i < 10; i++) srv.interleave.push(s => { s.restSec = 60 + i })
    await expect(call('log_bodyweight', { weight: 80, date: '2026-01-02' })).rejects.toMatchObject({ code: 'ECONFLICT' })
  })

  test('two tool calls at once are serialized, not raced', async () => {
    await Promise.all([
      call('log_bodyweight', { weight: 80, date: '2026-01-02' }),
      call('log_bodyweight', { weight: 81, date: '2026-01-03' }),
      call('set_goal_weight', { weight: 75 })
    ])
    expect(bwOn('2026-01-02').w).toBe(80)
    expect(bwOn('2026-01-03').w).toBe(81)
    expect(srv.state.targetW).toBe(75)
  })

  test('a profile with no synced document yet is refused', async () => {
    setup()
    srv.state = null
    await expect(call('set_goal_weight', { weight: 70 })).rejects.toMatchObject({ code: 'ENOSTATE' })
  })
})

describe('undo', () => {
  test('takes back exactly its own change', async () => {
    await call('log_bodyweight', { weight: 80, date: '2026-01-02' })
    const u = await call('undo_last_change', {})
    expect(u.ok).toBe(true)
    expect(bwOn('2026-01-02')).toBeUndefined()
    const hist = (await call('list_recent_changes', {})).changes
    expect(hist[0].undo_of).toBe(hist[1].change_id)
    expect(hist[1].status).toBe('undone')
  })

  test('leaves what a phone did in the meantime alone', async () => {
    await call('set_goal_weight', { weight: 75 })
    srv.state.bodyweight.push({ d: '2025-12-30', w: 88, t: 2 })        // the phone, later
    await call('undo_last_change', {})
    expect(srv.state.targetW).not.toBe(75)
    expect(bwOn('2025-12-30').w).toBe(88)
  })

  test('refuses when the same thing was changed since, unless forced', async () => {
    await call('log_bodyweight', { weight: 80, date: '2026-01-02' })
    bwOn('2026-01-02').w = 81                                        // the athlete corrected it
    await expect(call('undo_last_change', {})).rejects.toMatchObject({ code: 'ECONFLICT' })
    await call('undo_last_change', { force: true })
    expect(bwOn('2026-01-02')).toBeUndefined()
  })

  test('undo twice goes two changes back; an undo can itself be undone', async () => {
    await call('set_goal_weight', { weight: 75 })
    await call('set_goal_weight', { weight: 74 })
    await call('undo_last_change', {})
    expect(srv.state.targetW).toBe(75)
    const second = await call('undo_last_change', {})
    expect(srv.state.targetW).toBe(buildDemoState().targetW ?? null)
    await call('undo_last_change', { change_id: second.change_id })   // redo
    expect(srv.state.targetW).toBe(75)
  })

  test('nothing to undo is an error, not a write', async () => {
    await expect(call('undo_last_change', {})).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('journal: diff and undo on their own', () => {
  test('a routine reorder, an edit and an add come back out in one undo', () => {
    const before = buildDemoState()
    const after = clone(before)
    after.routines.reverse()
    after.routines[0].name = 'Renamed'
    after.routines.push({ id: 'rNew', name: 'New', ex: [] })
    after.week['2'] = ['rNew']
    const patches = diffState(before, after)
    const back = applyUndo(clone(after), patches)
    expect(back.routines).toEqual(before.routines)
    expect(back.week).toEqual(before.week)
  })

  test('the invariants refuse a week that points at nothing', () => {
    const before = buildDemoState()
    const after = clone(before)
    after.week['2'] = ['ghost']
    expect(() => checkInvariants(after, diffState(before, after))).toThrow(/does not exist/)
  })
})

describe('search_exercises', () => {
  test('finds by name, filters by body part, and includes the athlete\'s own exercises', () => {
    const s = clone(buildDemoState())
    s.customEx = [{ id: 'cMine1', n: 'Zercher Walk Special', bp: 'upper legs', eq: 'barbell', tg: 'quads', custom: true }]
    _seedStateForTests(s)
    const r = call('search_exercises', { query: 'bench press', limit: 5 })
    expect(r.exercises.length).toBeGreaterThan(0)
    expect(r.exercises[0]).toHaveProperty('id')
    const legs = call('search_exercises', { query: 'squat', body_part: 'upper legs' })
    expect(legs.exercises.every(e => e.body_part === 'upper legs')).toBe(true)
    expect(call('search_exercises', { query: 'zercher walk special' }).exercises[0].id).toBe('cMine1')
  })
})

describe('api client', () => {
  const fakeFetch = (status, body) => async () => ({ status, json: async () => body })
  test('a 409 becomes a ConflictError carrying the current document', async () => {
    const c = createApiClient({ base: 'http://x', token: 't', fetchImpl: fakeFetch(409, { state: { a: 1 }, rev: 7 }) })
    await expect(c.write({}, 1, 'op')).rejects.toBeInstanceOf(ConflictError)
    await expect(c.write({}, 1, 'op')).rejects.toMatchObject({ rev: 7, state: { a: 1 } })
  })
  test('a 404 says writes are not enabled on the api', async () => {
    const c = createApiClient({ base: 'http://x', token: 't', fetchImpl: fakeFetch(404, { error: 'not found' }) })
    await expect(c.read()).rejects.toMatchObject({ code: 'EAPI', message: expect.stringMatching(/OPENGYM_MCP_WRITE/) })
  })
  test('an unreachable api is an EAPI error, not a crash', async () => {
    const c = createApiClient({ base: 'http://x', token: 't', fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
    await expect(c.read()).rejects.toMatchObject({ code: 'EAPI' })
  })
})

// ---- from the review ----

describe('history status, redo bookkeeping', () => {
  test('status tells whether a change is still in effect or was changed since', async () => {
    await call('log_bodyweight', { weight: 80, date: '2026-01-02' })
    expect((await call('list_recent_changes', {})).changes[0].status).toBe('in effect')
    bwOn('2026-01-02').w = 82                                   // a phone merged over it
    expect((await call('list_recent_changes', {})).changes[0].status).toBe('changed since')
  })

  test('undoing an undo puts the change back in effect, and the next undo takes that one again', async () => {
    await call('set_goal_weight', { weight: 75 })                 // W
    const x = await call('set_goal_weight', { weight: 74 })       // X
    const u = await call('undo_last_change', {})                  // undoes X → 75
    await call('undo_last_change', { change_id: u.change_id })    // redo X → 74
    expect(srv.state.targetW).toBe(74)
    const hist = (await call('list_recent_changes', {})).changes
    expect(hist.find(c => c.change_id === x.change_id).status).toBe('in effect')
    await call('undo_last_change', {})                            // X again, not W
    expect(srv.state.targetW).toBe(75)
  })
})

describe('one zone for today and for wall-clock times', () => {
  test('zonedEpoch lands a wall clock in its zone, summer and winter', () => {
    expect(zonedEpoch('2026-07-01', '18:00', 'Asia/Jerusalem')).toBe(Date.UTC(2026, 6, 1, 15, 0))
    expect(zonedEpoch('2026-01-15', '18:00', 'Asia/Jerusalem')).toBe(Date.UTC(2026, 0, 15, 16, 0))
    expect(zonedEpoch('2026-07-01', '18:00', 'America/Los_Angeles')).toBe(Date.UTC(2026, 6, 2, 1, 0))
    expect(zonedEpoch('2026-07-01', '10:00', 'Pacific/Kiritimati')).toBe(Date.UTC(2026, 5, 30, 20, 0))
  })

  test("today is the athlete's day: the reminder zone, then TZ, then the machine", () => {
    const noon = Date.UTC(2026, 5, 30, 12, 0)
    expect(todayFor({ reminder: { tz: 'Pacific/Kiritimati' } }, noon)).toBe('2026-07-01')
    expect(todayFor({ reminder: { tz: 'America/Los_Angeles' } }, noon)).toBe('2026-06-30')
    expect(zoneFor({ reminder: { tz: 'Not/AZone' } })).not.toBe('Not/AZone')
    expect(zoneFor({})).toBeTruthy()
  })

  test("turning a reminder on for a profile with no zone stamps the athlete's zone", async () => {
    srv.state.reminder = { on: false, time: '08:00', tz: null }
    await call('update_settings', { reminder_on: true })
    expect(srv.state.reminder.tz).toBe(zoneFor({}))
  })
})
