// The persisted boundary for a finished session. Keep this pure so compatibility tests can
// exercise the exact shape the UI writes without mounting React or mutating store state.
import { bestWeightForEntry, bestWeightFor, workoutVolume, cleanupSg } from './history.js'
import { hasCompletedWork, isWarmupRow } from './workout-model.js'
import { betterWeight, beatsWeight } from './exercises.js'
import { backfillEnd, completeBackfill } from './backfill.js'

// The exercises whose heaviest completed work set beats every earlier session — a load PR, read
// against `S` as it was before this session was saved. A session logged into the past claims
// none: it cannot hold records against the history that came after it.
export function sessionPrs(S, active) {
  if (active.backfill) return []
  const prs = []
  for (const e of active.entries || []) {
    const loads = e.sets.filter(s => s.done && !isWarmupRow(s)).map(s => s.w).filter(w => w > 0)
    const mx = loads.length ? loads.reduce((a, b) => betterWeight(e.id, a, b)) : 0
    if (beatsWeight(e.id, mx, bestWeightFor(S, e.id))) prs.push(e.id)
  }
  return prs
}

// Everything the finish button does to the profile, without the UI around it: the PRs, the
// workout record and its volume, the confirmed working weights a live session raises, and where
// the record is filed — at the end for a live session, in date order (replacing one, if asked)
// for a past one. The one implementation behind sheets.jsx doFinishWorkout and the MCP server's
// log_workout, so the two cannot disagree about what finishing a workout means.
// Mutates `S` (the profile before this session) and returns { workout, prs }.
export function finishSession(S, active, { now = Date.now(), snapshotFor } = {}) {
  const past = !!active.backfill
  // A profile that has never finished anything may not carry the lists yet (the app's store
  // always does, from DEF; a document read from the server need not).
  S.workouts = Array.isArray(S.workouts) ? S.workouts : []
  S.exWeights = S.exWeights && typeof S.exWeights === 'object' ? S.exWeights : {}
  const prs = sessionPrs(S, active)
  const w = buildCompletedWorkout(active, { end: past ? backfillEnd(active) : now, prs, snapshotFor })
  w.vol = workoutVolume(w)
  if (past) {
    S.workouts = completeBackfill(S.workouts, active, w)
  } else {
    w.entries.forEach(e => {
      const mx = bestWeightForEntry(e)
      if (mx > 0 && beatsWeight(e.id, mx, (S.exWeights[e.id] || {}).w || 0)) S.exWeights[e.id] = { w: mx, d: w.d }
    })
    S.workouts.push(w)
  }
  return { workout: w, prs }
}

export function buildCompletedWorkout(active, { end = Date.now(), prs = [], snapshotFor } = {}) {
  const entries = (active?.entries || []).map(entry => {
    const completed = {
      id: entry.id,
      sets: entry.sets,
      topW: bestWeightForEntry(entry) || null,
      target: entry.target || null,
      // Which routine this entry came from, and whether it counts for progression. Written
      // only when set/true, so a single-routine non-excluded session is byte-for-byte the
      // shape it always was. Without this the whitelist drops both at finish.
      ...(entry.rid ? { rid: entry.rid } : {}),
      ...(entry.noProg === true ? { noProg: true } : {}),
      // Done as a superset: the members share an id, as in the session and the routine.
      ...(entry.sg ? { sg: entry.sg } : {}),
    }
    const snapshot = typeof snapshotFor === 'function' ? snapshotFor(entry) : null
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && Object.keys(snapshot).length) {
      completed.muscleSnapshot = { ...snapshot }
    }
    // What you typed about this exercise today, and whether you asked to see it again next
    // time. Written only when there is something to keep, so an untouched entry is byte-for-byte
    // the shape it always was.
    const note = (entry.note || '').trim()
    if (note) {
      completed.note = note
      if (entry.notePin) completed.notePin = true
    }
    return completed
  }).filter(entry => entry.sets.some(hasCompletedWork))
  // A member left out for having nothing done leaves its partner a group of one.
  cleanupSg(entries)

  const sessionNote = (active?.note || '').trim()
  const routineIds = [].concat(active?.routineIds ?? (active?.routineId ? [active.routineId] : []))
  // Legacy `w.excludeFromProgression` mirror: kept for older builds and external readers, but
  // it only makes sense when the *whole* session is excluded. Derived from the completed
  // entries, not read from `active` (which no longer carries the flag). A mixed session omits
  // it — that case is new territory only the per-entry `noProg` readers handle.
  const allNoProg = entries.length > 0 && entries.every(e => e.noProg === true)

  return {
    id: active.id,
    d: active.d,
    start: active.start,
    end,
    routineIds,
    routineId: routineIds[0] ?? null,
    name: active.name,
    bw: active.bw,
    entries,
    prs,
    ...(allNoProg ? { excludeFromProgression: true } : {}),
    ...(sessionNote ? { note: sessionNote } : {}),
  }
}
