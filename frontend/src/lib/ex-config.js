// One planned exercise in a routine, exactly as the routine editor saves it (ExConfig's save in
// sheets.jsx). Pure and Node-loadable, so anything else that writes a plan — the MCP server
// first — produces the same shape the app would, field for field: the same clamps, the same
// defaults, and the same "only written when it differs" rules that keep a plan file compact.
//
// Input uses the stored field names (sets, reps, repsMin, repsMax, weight, sec, min, speed,
// bodyweight, side, prog, inc, deloadFactor, note, warmupSets, restSec, intensifier); anything
// missing takes the sheet's default. `routine` is the routine it will live in, for the
// progression rule it inherits. The superset link (`sg`) is the routine's business, not the
// exercise's, and is never part of the result — see RoutineEdit.jsx, which keeps it apart too.
import { isCardio, isBodyweightEq } from './exercises.js'
import { modeOf, isBw, isPerSide, MAX_PLANNED_WARMUPS } from './history.js'
import { policyFor } from './progression.js'
import { normalizeRepRange } from './rep-range.js'

export const INTENSIFIER_TYPES = ['dropset', 'restpause']

// The two planned intensifiers and the ranges their steppers allow (sheets.jsx:1391-1399).
function cleanIntensifier(v) {
  if (!v || !INTENSIFIER_TYPES.includes(v.type)) return null
  if (v.type === 'dropset') {
    return { type: 'dropset', count: Math.max(1, Math.round(v.count) || 1), pct: Math.max(5, Number(v.pct) || 20) }
  }
  return { type: 'restpause', totalReps: Math.max(1, Math.round(v.totalReps) || 1), restSec: Math.max(5, Math.round(v.restSec) || 15) }
}

export function normalizeExConfig(c, routine) {
  const id = c.id
  const cardio = isCardio(id)
  const mode = cardio ? 'cardio' : modeOf({ ...c, id })
  const bw = !cardio && isBw({ ...c, id })
  const perSide = isPerSide(c)
  const activePolicy = policyFor({ ...c, id }, routine, mode)
  const double = mode === 'reps' && activePolicy === 'double'
  const sets = Math.max(1, Math.round(c.sets) || (cardio ? 1 : 3))
  // Only progression settings that differ from the inherited default, so "follow the routine"
  // keeps meaning exactly that.
  const prog = {}
  if (c.prog) prog.prog = c.prog
  if (c.inc > 0) prog.inc = c.inc
  // Epley deload: the 90% default stays omitted so older plans keep their compact shape.
  if (mode === 'reps' && !bw && (activePolicy === 'linear' || activePolicy === 'double')) {
    const deloadFactor = Math.max(0.5, Math.min(0.95, Number(c.deloadFactor) || 0.9))
    if (deloadFactor !== 0.9) prog.deloadFactor = deloadFactor
  }
  // Written only when it differs from what the dataset already says about the exercise.
  const flags = {}
  if (bw !== isBodyweightEq(id)) flags.bodyweight = bw
  const note = String(c.note || '').trim().slice(0, 500)
  const withNote = note ? { note } : {}
  const warmupSets = Math.max(0, Math.min(MAX_PLANNED_WARMUPS, Math.round(c.warmupSets) || 0))
  const withWarmups = warmupSets ? { warmupSets } : {}
  // Per-exercise rest: only a positive value is written; 0 inherits the global rest timer.
  const restSec = Math.max(0, Math.round(c.restSec) || 0)
  const withRest = restSec ? { restSec } : {}

  if (cardio) return { id, sets, min: Math.max(1, Math.round(c.min) || 20), speed: Math.max(0, Number(c.speed) || 8), ...withNote, ...withRest }
  // A timed hold has no reps to split, so `side` is dropped rather than carried along.
  if (mode === 'time') return { id, sets, mode: 'time', sec: Math.max(1, Math.round(c.sec) || 45), weight: Math.max(0, Number(c.weight) || 0), ...flags, ...prog, ...withNote, ...withWarmups, ...withRest }

  // A unilateral target is stored even: the split has to divide.
  const typed = Math.max(1, Math.round(c.reps) || 10)
  const stride = perSide ? 2 : 1
  let reps = perSide ? Math.ceil(typed / stride) * stride : typed
  let range = null
  if (double) {
    range = normalizeRepRange(reps, c.repsMin, stride)
    reps = range.reps
  }
  const out = { id, sets, mode: 'reps', reps, weight: Math.max(0, Number(c.weight) || 0), ...flags, ...(perSide ? { side: true } : {}), ...prog, ...withNote, ...withWarmups, ...withRest }
  if (double) out.repsMin = range.repsMin
  // A ceiling below the working reps would tell you to add a set on day one.
  if (bw && !(out.weight > 0) && c.repsMax > 0) out.repsMax = Math.max(reps, Math.round(c.repsMax))
  const intensifier = cleanIntensifier(c.intensifier)
  if (intensifier) out.intensifier = intensifier
  return out
}
