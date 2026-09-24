/* Checks a write must pass before it is sent: whatever the tool did, the document that reaches
   the api must be one the app can open. Checked are the parts this write touched (from its
   patches) plus the references into them — never the whole profile, whose older entries were
   written by the app and are the app's to judge; refusing every write over a quirk in a
   two-year-old workout would help nobody. */
import { EXIDX } from '../../frontend/src/lib/exercises.js'

// Every device pushes the whole document through nginx's 5 MB body cap (web/nginx.conf.template).
export const MAX_DOC_BYTES = 4.5 * 1024 * 1024
const ISO = /^\d{4}-\d{2}-\d{2}$/
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const WEEKDAYS = new Set(['0', '1', '2', '3', '4', '5', '6'])

export const isIsoDate = s => typeof s === 'string' && ISO.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) &&
  new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s

export function invariantError(msg) {
  const e = new Error(msg)
  e.code = 'EINVALID'
  return e
}

const routineIds = S => new Set((S.routines || []).map(r => r && r.id))
// A library exercise from the index; a custom one only from this document. The index also holds
// whatever customs were registered last, which may include one this document has since deleted.
export const exerciseExists = (id, S) => (!!EXIDX[id] && !EXIDX[id].custom) || (S.customEx || []).some(c => c && c.id === id)

export function checkInvariants(after, patches) {
  const problems = []
  const ids = routineIds(after)
  for (const p of patches) {
    if (p.kind === 'item' && p.field === 'bodyweight' && p.after) {
      const b = p.after
      if (!isIsoDate(b.d)) problems.push(`weigh-in date ${JSON.stringify(b.d)} is not a date`)
      if (!(Number.isFinite(b.w) && b.w > 0 && b.w < 1500)) problems.push(`weigh-in weight ${b.w} is out of range`)
    }
    if (p.kind === 'item' && p.field === 'routines' && p.after) {
      const r = p.after
      if (!SAFE_ID.test(String(r.id))) problems.push(`routine id ${JSON.stringify(r.id)} is not a safe id`)
      if (typeof r.name !== 'string' || !r.name.trim()) problems.push(`routine ${r.id} has no name`)
      if (!Array.isArray(r.ex)) problems.push(`routine ${r.id} has no exercise list`)
      else for (const cfg of r.ex) if (!cfg || !exerciseExists(cfg.id, after)) problems.push(`routine ${r.name} names an exercise that does not exist: ${cfg && cfg.id}`)
    }
    if (p.kind === 'key' && p.field === 'week' && p.after !== undefined) {
      if (!WEEKDAYS.has(String(p.key))) problems.push(`week has a day ${p.key} that is not 0-6`)
      const v = [].concat(p.after)
      if (!v.length) problems.push(`week day ${p.key} is an empty list — a rest day is a missing key`)
      for (const id of v) if (!ids.has(id)) problems.push(`week day ${p.key} names a routine that does not exist: ${id}`)
    }
    if (p.kind === 'key' && p.field === 'dayPlan' && p.after !== undefined) {
      if (!isIsoDate(p.key)) problems.push(`day override ${p.key} is not a date`)
      if (p.after !== 'rest' && !ids.has(p.after)) problems.push(`day override ${p.key} names a routine that does not exist: ${p.after}`)
    }
    if (p.kind === 'field' && p.field === 'targetW' && p.after != null && !(Number.isFinite(p.after) && p.after > 0 && p.after < 1500)) {
      problems.push(`goal weight ${p.after} is out of range`)
    }
    // A deleted routine must not stay scheduled anywhere.
    if (p.kind === 'item' && p.field === 'routines' && p.after === undefined) {
      for (const [d, v] of Object.entries(after.week || {})) if ([].concat(v).includes(p.key)) problems.push(`deleted routine ${p.key} is still on week day ${d}`)
      for (const [d, v] of Object.entries(after.dayPlan || {})) if (v === p.key) problems.push(`deleted routine ${p.key} is still planned for ${d}`)
    }
  }
  if (JSON.stringify(after).length > MAX_DOC_BYTES) problems.push('the profile would grow past what a device can sync (4.5 MB)')
  if (problems.length) throw invariantError(problems.join('; '))
}
