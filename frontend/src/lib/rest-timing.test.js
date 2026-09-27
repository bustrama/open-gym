import { describe, it, expect } from 'vitest'
import { restAfterPhone, REST_STEP } from './rest-timing.js'

const NOW = Date.UTC(2026, 8, 27, 18, 0, 0)
// A 90-second rest, 60 seconds of it left.
const timer = { key: 'r1', endsAt: NOW + 60000, left: 60, total: 90, forIdx: 2, forSet: 1 }

describe('restAfterPhone', () => {
  it('moves the end, what is left and the total by the time a button added', () => {
    expect(restAfterPhone(timer, { key: 'r1', endsAt: NOW + 75000 }, NOW)).toEqual({ ...timer, endsAt: NOW + 75000, left: 75, total: 105 })
    expect(restAfterPhone(timer, { key: 'r1', endsAt: NOW + 45000 }, NOW)).toEqual({ ...timer, endsAt: NOW + 45000, left: 45, total: 75 })
  })

  it('counts from now, not from when the button was tapped', () => {
    // tapped +15 at 60 left, heard 10 seconds later
    expect(restAfterPhone(timer, { key: 'r1', endsAt: NOW + 75000 }, NOW + 10000)).toMatchObject({ left: 65, total: 105 })
  })

  it('keeps which set the rest belongs to', () => {
    expect(restAfterPhone(timer, { key: 'r1', endsAt: NOW + 75000 }, NOW)).toMatchObject({ key: 'r1', forIdx: 2, forSet: 1 })
  })

  it('ends the rest on Skip', () => {
    expect(restAfterPhone(timer, { key: 'r1', skipped: true }, NOW)).toBeNull()
  })

  it('ignores a change to another rest, or with no rest on screen', () => {
    expect(restAfterPhone(timer, { key: 'r0', skipped: true }, NOW)).toBeUndefined()
    expect(restAfterPhone(timer, { key: 'r0', endsAt: NOW + 75000 }, NOW)).toBeUndefined()
    expect(restAfterPhone(null, { key: 'r1', skipped: true }, NOW)).toBeUndefined()
    // the Settings test rest has no key; neither does a rest from before keys
    expect(restAfterPhone({ ...timer, key: undefined }, { key: '', skipped: true }, NOW)).toBeUndefined()
  })

  it('ignores a change that changes nothing or makes no sense', () => {
    expect(restAfterPhone(timer, { key: 'r1', endsAt: timer.endsAt }, NOW)).toBeUndefined()
    expect(restAfterPhone(timer, { key: 'r1', endsAt: 'soon' }, NOW)).toBeUndefined()
    expect(restAfterPhone(timer, null, NOW)).toBeUndefined()
  })

  it('leaves nothing left for an end already past, so the tick ends the rest', () => {
    const late = restAfterPhone(timer, { key: 'r1', endsAt: NOW + 75000 }, NOW + 80000)
    expect(late).toMatchObject({ endsAt: NOW + 75000, left: 0 })
    expect(late.total).toBeGreaterThan(0)
  })

  it('never lets the total drop under what is left', () => {
    const short = { ...timer, total: 10, left: 10, endsAt: NOW + 10000 }
    expect(restAfterPhone(short, { key: 'r1', endsAt: NOW + 25000 }, NOW - 5000).total).toBeGreaterThanOrEqual(30)
  })

  it('steps by 15 seconds', () => {
    expect(REST_STEP).toBe(15)
  })
})
