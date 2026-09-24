/* What each MCP write changed, and how to take it back.

   A change is recorded as keyed patches, not as a copy of the document: routines, workouts and
   custom exercises by id, weigh-ins by day, week / dayPlan / exWeights / notes / bar weights by
   key, routine order, and every other top-level field on its own. Undo then puts back `before`
   only where the value is still exactly what this change left (`after`). Restoring a whole
   snapshot instead would also undo whatever a phone did in the meantime — a workout logged after
   an agent's edit would vanish from every device — so a patch whose value has moved on since is a
   conflict, refused unless the caller forces it.

   The journal survives restarts when OPENGYM_MCP_JOURNAL names a writable directory, and lives
   in memory otherwise. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Lists whose entries have a natural key. Order is the app's to decide for all of these but
// routines (sorted by day, or by date and start) — routine order is what the Plan screen shows,
// so it is recorded as a patch of its own.
const KEYED = { routines: 'id', workouts: 'id', customEx: 'id', bodyweight: 'd', gymCards: 'id', equipProfiles: 'id' }
const MAPS = ['week', 'dayPlan', 'exWeights', 'exNotes', 'barWeights']
// Server- or device-owned: never part of a change, never restored.
const SKIP = new Set(['_ts', '_rev', 'active'])

// Order-insensitive for object keys: the same values written in another key order are the same
// value, and must not show up as a change (or as a conflict when undoing one).
const canon = v => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v)
export const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b))
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const list = v => (Array.isArray(v) ? v : [])
const map = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

export function diffState(before, after) {
  const patches = []
  for (const [field, key] of Object.entries(KEYED)) {
    const b = new Map(list(before[field]).map(x => [x && x[key], x]))
    const a = new Map(list(after[field]).map(x => [x && x[key], x]))
    const pos = new Map(list(before[field]).map((x, i) => [x && x[key], i]))
    for (const k of new Set([...b.keys(), ...a.keys()])) {
      // `pos`: where an entry that is taken away used to sit, so undoing puts it back there.
      if (!same(b.get(k), a.get(k))) patches.push({ kind: 'item', field, key: k, pos: pos.get(k), before: clone(b.get(k)), after: clone(a.get(k)) })
    }
    if (field === 'routines') {
      const bo = list(before.routines).map(r => r && r.id)
      const ao = list(after.routines).map(r => r && r.id)
      // Only a reorder of routines that exist on both sides; an add or a delete is its own patch.
      const common = ao.filter(id => bo.includes(id))
      if (!same(bo.filter(id => ao.includes(id)), common)) patches.push({ kind: 'order', field, before: bo, after: ao })
    }
  }
  for (const field of MAPS) {
    const b = map(before[field])
    const a = map(after[field])
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (!same(b[k], a[k])) patches.push({ kind: 'key', field, key: k, before: clone(b[k]), after: clone(a[k]) })
    }
  }
  const handled = new Set([...Object.keys(KEYED), ...MAPS, ...SKIP])
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (handled.has(field)) continue
    if (!same(before[field], after[field])) patches.push({ kind: 'field', field, before: clone(before[field]), after: clone(after[field]) })
  }
  return patches
}

function currentOf(state, p) {
  if (p.kind === 'item') return list(state[p.field]).find(x => x && x[KEYED[p.field]] === p.key)
  if (p.kind === 'key') return map(state[p.field])[p.key]
  if (p.kind === 'order') return list(state[p.field]).map(r => r && r.id)
  return state[p.field]
}

const describe = p => (p.kind === 'item' || p.kind === 'key') ? `${p.field}[${p.key}]` : p.kind === 'order' ? `${p.field} order` : p.field

// The same app-side order a fresh write would produce.
function resort(state, field) {
  if (field === 'bodyweight') state.bodyweight.sort((a, b) => (a.d < b.d ? -1 : 1))
  if (field === 'workouts') state.workouts.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : (a.start || 0) - (b.start || 0)))
}

// Puts each patch's `before` back. Throws with the conflicting paths unless `force`.
export function applyUndo(state, patches, { force = false } = {}) {
  const conflicts = patches.filter(p => {
    const cur = currentOf(state, p)
    if (p.kind === 'order') return !same(cur.filter(id => p.after.includes(id)), p.after.filter(id => cur.includes(id)))
    return !same(cur, p.after)
  })
  if (conflicts.length && !force) {
    const e = new Error(`changed again since, so undoing would overwrite newer edits: ${conflicts.map(describe).join(', ')} — pass force to undo anyway`)
    e.code = 'ECONFLICT'
    throw e
  }
  for (const p of [...patches].reverse()) {
    if (p.kind === 'item') {
      const key = KEYED[p.field]
      const arr = list(state[p.field])
      const i = arr.findIndex(x => x && x[key] === p.key)
      if (p.before === undefined) { if (i >= 0) arr.splice(i, 1) }
      else if (i >= 0) arr[i] = clone(p.before)
      else arr.splice(Math.min(p.pos ?? arr.length, arr.length), 0, clone(p.before))
      state[p.field] = arr
      resort(state, p.field)
    } else if (p.kind === 'key') {
      const m = map(state[p.field])
      if (p.before === undefined) delete m[p.key]
      else m[p.key] = clone(p.before)
      state[p.field] = m
    } else if (p.kind === 'field') {
      if (p.before === undefined) delete state[p.field]
      else state[p.field] = clone(p.before)
    }
  }
  // Routine order last, once every add and delete is back in place: the old order for the
  // routines it knew about, anything newer after them in its current order.
  for (const p of patches) {
    if (p.kind !== 'order') continue
    const byId = new Map(list(state.routines).map(r => [r.id, r]))
    const ordered = p.before.filter(id => byId.has(id)).map(id => byId.get(id))
    const rest = list(state.routines).filter(r => !p.before.includes(r.id))
    state.routines = [...ordered, ...rest]
  }
  return state
}

// Whether a change is still what the profile says: 'in effect' when every value it wrote is
// still there, 'changed since' when something it touched has moved on — the athlete edited it,
// or a device that synced an older copy merged over it.
export function statusOf(patches, state) {
  const moved = patches.some(p => {
    const cur = currentOf(state, p)
    if (p.kind === 'order') return !same(cur.filter(id => p.after.includes(id)), p.after.filter(id => cur.includes(id)))
    return !same(cur, p.after)
  })
  return moved ? 'changed since' : 'in effect'
}

export function summarize(patches) {
  return patches.map(p => {
    const verb = p.kind === 'order' ? 'reordered' : p.before === undefined ? 'added' : p.after === undefined ? 'removed' : 'changed'
    return `${verb} ${describe(p)}`
  })
}

export function createJournal({ dir = process.env.OPENGYM_MCP_JOURNAL || null, max = 200 } = {}) {
  const file = dir ? path.join(dir, 'journal.json') : null
  let entries = []
  if (file) {
    try { entries = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { entries = [] }
    if (!Array.isArray(entries)) entries = []
  }
  let warned = false
  function persist() {
    if (!file) return
    try {
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (e) {
      // The write itself already landed on the api; only the undo history is in memory now.
      if (!warned) console.error(`[opengym-mcp] journal not saved (${e.message}) — undo history is in memory only`)
      warned = true
    }
  }
  return {
    record({ op, reason, rev, patches, undoes = null, requestId = null, meta = null }) {
      const entry = { id: crypto.randomBytes(6).toString('hex'), ts: Date.now(), op, reason: reason || null, rev, patches, undoes, undone_by: null, request_id: requestId, meta }
      entries.push(entry)
      if (entries.length > max) entries = entries.slice(-max)
      if (undoes) {
        const target = entries.find(x => x.id === undoes)
        if (target) {
          target.undone_by = entry.id
          // Undoing an undo puts the change that undo had taken back into effect again.
          if (target.undoes) { const orig = entries.find(x => x.id === target.undoes); if (orig) orig.undone_by = null }
        }
      }
      persist()
      return entry
    },
    get: id => entries.find(e => e.id === id) || null,
    // A client (or a proxy) that repeats a call it already made gets the first answer back.
    byRequest: requestId => (requestId ? entries.find(e => e.request_id === requestId) || null : null),
    // The newest change still in effect — not itself an undo, and not undone.
    latest: () => [...entries].reverse().find(e => !e.undone_by && !e.undoes) || null,
    list: (limit = 10) => [...entries].reverse().slice(0, limit)
  }
}
