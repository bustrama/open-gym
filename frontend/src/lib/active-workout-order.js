import { supersetUnits, setUnits, doneUnits } from './history.js'
import { nextUnfinishedUnit } from './supersetFlow.js'

const unitHasWork = (entries, unit) => unit.some(idx => entries[idx]?.sets?.some(set => !set.done))

const currentIndex = active => (Number.isInteger(active.cur)
  ? Math.min(Math.max(active.cur, 0), Math.max(0, active.entries.length - 1))
  : 0)

function moveTarget(active, index, direction) {
  if (!active || !Array.isArray(active.entries) || (direction !== -1 && direction !== 1)) return null
  const units = supersetUnits(active.entries)
  const source = units.findIndex(unit => unit.includes(index))
  const target = source + direction
  if (source < 0 || target < 0 || target >= units.length) return null
  return { units, source, target }
}

export function canMoveActiveWorkoutUnit(active, index, direction) {
  return moveTarget(active, index, direction) !== null
}

export function moveActiveWorkoutUnit(active, index, direction) {
  const move = moveTarget(active, index, direction)
  if (!move) return null

  const selected = active.entries[index]
  const reorderedUnits = [...move.units]
  const sourceUnit = reorderedUnits[move.source]
  reorderedUnits[move.source] = reorderedUnits[move.target]
  reorderedUnits[move.target] = sourceUnit
  const indices = reorderedUnits.flat()
  const reorderedEntries = indices.map(entryIndex => active.entries[entryIndex])

  active.entries.splice(0, active.entries.length, ...reorderedEntries)
  active.cur = active.entries.indexOf(selected)
  return { indices }
}

function postponeTarget(active, index) {
  if (!active || !Array.isArray(active.entries)) return null
  const units = supersetUnits(active.entries)
  const source = units.findIndex(unit => unit.includes(index))
  if (source < 0 || !unitHasWork(active.entries, units[source])) return null
  let last = -1
  units.forEach((unit, i) => { if (i !== source && unitHasWork(active.entries, unit)) last = i })
  if (last < 0) return null
  return { units, source, target: Math.max(source, last) }
}

// Only a unit with sets left can wait, and only behind another one that has sets left.
export function canPostponeActiveWorkoutUnit(active, index) {
  return postponeTarget(active, index) !== null
}

/**
 * "Do later": the machine is taken, so this exercise waits its turn. Its whole unit (a superset
 * moves as one) goes behind the last unit that still has sets to do — finished units are no
 * queue to wait in, so it never lands behind them. A unit that is already behind every
 * unfinished one keeps its place.
 *
 * Postponing the current unit hands the marker to the unit that would have come next
 * (nextUnfinishedUnit, which wraps). Postponing another unit leaves the marker on its own
 * entry. Like moveActiveWorkoutUnit it mutates `active` and returns the old index of each entry
 * in its new place, so the caller can re-point anything that was keyed by index.
 */
export function postponeActiveWorkoutUnit(active, index) {
  const move = postponeTarget(active, index)
  if (!move) return null
  const { units, source, target } = move
  const cur = currentIndex(active)
  const follow = units[source].includes(cur)
    ? active.entries[nextUnfinishedUnit(active.entries, units, cur)[0]]
    : active.entries[cur]

  const reordered = units.filter((_, i) => i !== source)
  reordered.splice(target, 0, units[source])
  const indices = reordered.flat()
  const reorderedEntries = indices.map(entryIndex => active.entries[entryIndex])

  active.entries.splice(0, active.entries.length, ...reorderedEntries)
  active.cur = Math.max(0, active.entries.indexOf(follow))
  return { indices }
}

const progressOf = entry => {
  const sets = Array.isArray(entry?.sets) ? entry.sets : []
  return {
    done: sets.reduce((n, set) => n + doneUnits(set), 0),
    total: sets.reduce((n, set) => n + setUnits(set), 0),
  }
}
const statusOf = ({ done, total }) => (total > 0 && done >= total ? 'done' : done > 0 ? 'started' : 'todo')

/**
 * One row per unit, in session order, for the exercises overview: the member entries with
 * their set counts, the unit's own counts and status ('done' | 'started' | 'todo'), and
 * whether it holds the current marker. Sets count the way the header does: a per-side set is
 * two, so the numbers add up to the header's "x/y sets".
 */
export function activeWorkoutOverview(active) {
  if (!active || !Array.isArray(active.entries) || !active.entries.length) return []
  const cur = currentIndex(active)
  return supersetUnits(active.entries).map(unit => {
    const members = unit.map(idx => {
      const progress = progressOf(active.entries[idx])
      return { idx, id: active.entries[idx].id, ...progress, status: statusOf(progress) }
    })
    const progress = {
      done: members.reduce((n, m) => n + m.done, 0),
      total: members.reduce((n, m) => n + m.total, 0),
    }
    return { indices: unit, current: unit.includes(cur), ...progress, status: statusOf(progress), members }
  })
}

/**
 * What the rest after entry `forIdx`'s set leads into, for the rest bar's "Up next": the next
 * unit with sets left (nextUnfinishedUnit, entry indices) once the resting unit is finished.
 * While the unit still has sets the next thing is simply its next set, so there is nothing
 * to announce: null, as for an unknown owner.
 */
export function upNextAfterRest(active, forIdx) {
  if (!active || !Array.isArray(active.entries) || !Number.isInteger(forIdx) || !active.entries[forIdx]) return null
  const units = supersetUnits(active.entries)
  const own = units.find(unit => unit.includes(forIdx))
  if (!own || unitHasWork(active.entries, own)) return null
  return nextUnfinishedUnit(active.entries, units, forIdx)
}
