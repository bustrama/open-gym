/* Routine tools: create, update, delete, reorder. Every exercise goes through normalizeExConfig
   (frontend/src/lib/ex-config.js), the routine editor's own save rules, so a routine written
   here is the routine the app would have saved — same defaults, clamps and compact shape.

   The exercise fields are the ones get_routine returns, so an agent can read a routine, change
   what it wants, and send the list back without translating anything. */
import { z } from 'zod'
import { toolError } from './writer.js'
import { exerciseExists } from './invariants.js'
import { same } from './journal.js'
import { normalizeExConfig, INTENSIFIER_TYPES } from '../../frontend/src/lib/ex-config.js'
import { registerCustom, isCardio, exOr } from '../../frontend/src/lib/exercises.js'
import { cleanupSg, exLine } from '../../frontend/src/lib/history.js'
import { POLICIES_FOR } from '../../frontend/src/lib/progression.js'
import { uid } from '../../frontend/src/lib/format.js'

// lib/glyphs.js GLYPH_GROUPS, repeated here because that module imports the Icon component
// and cannot load under plain node.
const ICONS = ['figureStrength', 'arm', 'abs', 'legs', 'pullup', 'dumbbell', 'barbell', 'kettlebell', 'plate', 'machine',
  'figureRun', 'bike', 'swim', 'boxing', 'timer', 'stretch', 'moon', 'heart', 'flame', 'bolt']
const DEFAULT_ICON = 'figureStrength'
const ROUTINE_RULES = POLICIES_FOR.reps              // off, linear, greyskull, double
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const reasonSchema = z.string().max(300).optional().describe('Why — kept in the change history next to the change')
const requestIdSchema = z.string().min(1).max(100).optional()
  .describe('Any unique string: sending the same call again with it returns the first result instead of creating a second one')

const exerciseSchema = z.object({
  id: z.string().min(1).describe('Exercise id, from search_exercises or get_routine'),
  mode: z.enum(['reps', 'time', 'cardio']).optional().describe('reps (default) or time for holds and carries. Cardio exercises are always cardio (and only they are).'),
  sets: z.number().int().min(1).max(100).optional(),
  reps: z.number().int().min(1).max(1000).optional().describe('Target reps. Under double progression the top of the range. With per_side, the total of both sides.'),
  reps_min: z.number().int().min(1).max(1000).optional().describe('Double progression: the bottom of the rep range'),
  reps_max: z.number().int().min(1).max(1000).optional().describe('Unloaded bodyweight work: add a set once this many reps are reached'),
  weight: z.number().min(0).max(10000).optional().describe('Working weight in the profile unit. On a bodyweight exercise, the ADDED weight.'),
  sec: z.number().int().min(1).max(86400).optional().describe('Time mode: seconds per set'),
  min: z.number().int().min(1).max(1440).optional().describe('Cardio: minutes'),
  speed: z.number().min(0).max(100).optional().describe('Cardio: km/h'),
  bodyweight: z.boolean().optional().describe('Override whether the exercise carries no load of its own (default from the exercise library)'),
  per_side: z.boolean().optional().describe('Unilateral (reps mode only)'),
  policy_override: z.enum(['off', 'linear', 'greyskull', 'double', 'time']).nullable().optional()
    .describe('This exercise\'s own progression rule. Absent/null follows the routine. reps: off/linear/greyskull/double; time: off/time; cardio: off.'),
  increment: z.number().positive().max(1000).optional().describe('Progression step in the profile unit (seconds in time mode). Absent: the exercise\'s default.'),
  deload_factor: z.number().min(0.5).max(0.95).optional().describe('Epley deload after a stall (default 0.9)'),
  warmup_sets: z.number().int().min(0).max(5).optional(),
  rest_sec: z.number().int().min(0).max(86400).optional().describe('Rest after this exercise. 0/absent: the global rest timer.'),
  note: z.string().max(500).optional(),
  intensifier: z.union([
    z.object({ type: z.literal('dropset'), count: z.number().int().min(1).max(50), pct: z.number().min(5).max(95) }),
    z.object({ type: z.literal('restpause'), total_reps: z.number().int().min(1).max(10000), rest_sec: z.number().int().min(5).max(3600) })
  ]).nullable().optional().describe('Reps mode only: every work set becomes a drop set or a rest-pause set'),
  superset_group: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).nullable().optional()
    .describe('Consecutive exercises with the same label form a superset')
})

// Tool fields → the stored config's names, for normalizeExConfig.
function toCfg(e) {
  const i = e.intensifier
  return {
    // Cardio is the exercise's, never the config's: normalizeExConfig reads it off the library.
    id: e.id, mode: e.mode === 'cardio' ? undefined : e.mode, sets: e.sets, reps: e.reps, repsMin: e.reps_min, repsMax: e.reps_max, weight: e.weight,
    sec: e.sec, min: e.min, speed: e.speed, bodyweight: e.bodyweight, side: e.per_side,
    prog: e.policy_override || undefined, inc: e.increment, deloadFactor: e.deload_factor,
    warmupSets: e.warmup_sets, restSec: e.rest_sec, note: e.note,
    intensifier: !i ? undefined : i.type === 'dropset'
      ? { type: 'dropset', count: i.count, pct: i.pct }
      : { type: 'restpause', totalReps: i.total_reps, restSec: i.rest_sec }
  }
}

// The exercise list as the routine editor stores it: `{ id, sg?, ...config }`, superset labels
// kept only where a neighbour shares them (cleanupSg, as the editor does after every change).
// `existing` is the list being replaced: an exercise sent back unchanged keeps its stored form
// byte for byte — a config saved before `mode` existed stays that way until someone actually
// edits it, as it would in the app — so a full-list update only writes what really changed.
function buildExercises(inputs, routine, S, existing = []) {
  // One process answers for one profile (OPENGYM_UID), so its custom exercises can join the
  // shared index — isCardio / isBodyweightEq then classify them the way the app does.
  registerCustom(S.customEx || [])
  const problems = []
  const ex = inputs.map((e, n) => {
    const at = `exercise ${n + 1} (${e.id})`
    if (!exerciseExists(e.id, S)) { problems.push(`${at}: no such exercise — search_exercises has the ids`); return null }
    const mode = isCardio(e.id) ? 'cardio' : (e.mode || 'reps')
    if (isCardio(e.id) && e.mode && e.mode !== 'cardio') problems.push(`${at}: a cardio exercise is always cardio`)
    if (!isCardio(e.id) && e.mode === 'cardio') problems.push(`${at}: only cardio exercises can be cardio — use reps or time`)
    if (e.policy_override && !POLICIES_FOR[mode].includes(e.policy_override)) {
      problems.push(`${at}: progression "${e.policy_override}" does not apply to ${mode} work (allowed: ${POLICIES_FOR[mode].join(', ')})`)
    }
    if (e.intensifier && (mode !== 'reps' || !INTENSIFIER_TYPES.includes(e.intensifier.type))) problems.push(`${at}: an intensifier needs reps mode`)
    const { id, ...cfg } = normalizeExConfig(toCfg(e), routine)
    const sg = e.superset_group ? (e.superset_group.startsWith('sg') ? e.superset_group : 'sg' + e.superset_group) : null
    return { id, ...(sg ? { sg } : {}), ...cfg }
  })
  if (problems.length) throw toolError('EINVALID', problems.join('; '))
  cleanupSg(ex)
  const used = new Set()
  return ex.map((cfg, n) => {
    // The same exercise at the same place first, else its first unclaimed occurrence.
    const at = [n, ...existing.keys()].find(i => !used.has(i) && existing[i] && existing[i].id === cfg.id)
    if (at === undefined) return cfg
    const { sg: oldSg, ...old } = existing[at]
    const { sg, ...fresh } = cfg
    if ((oldSg || null) !== (sg || null) || !same(normalizeExConfig(old, routine), fresh)) return cfg
    used.add(at)
    return JSON.parse(JSON.stringify(existing[at]))
  })
}

function findRoutine(S, id) {
  const r = (S.routines || []).find(x => x.id === id)
  if (!r) throw toolError('ENOENT', `no routine with id ${JSON.stringify(id)} — list_routines has the ids`)
  return r
}

const view = (r, S) => ({
  routine_id: r.id,
  name: r.name,
  exercises: r.ex.map(cfg => `${exOr(cfg.id).n}: ${exLine(cfg, S.unit || 'kg')}${cfg.sg ? ` [superset ${cfg.sg}]` : ''}`)
})

function result(res, extra) {
  return res.changed
    ? { ok: true, change_id: res.change_id, changes: res.changes, ...extra }
    : { ok: true, changed: false, note: 'already like that — nothing was written', ...extra }
}

export function routineTools(writer) {
  const createRoutine = {
    name: 'create_routine',
    description: 'Create a routine: a named list of exercises with their targets. Exercises use the same fields get_routine returns; anything left out takes the app\'s default (3 × 10, no weight). Optionally schedule it on weekdays straight away.',
    schema: {
      name: z.string().trim().min(1).max(200),
      icon: z.enum(ICONS).optional(),
      progression: z.enum(ROUTINE_RULES).optional().describe('How the routine\'s lifts progress (default linear): off, linear, greyskull, double'),
      exclude_from_progression: z.boolean().optional().describe('Sessions of this routine never move working weights (deloads, technique days)'),
      exercises: z.array(exerciseSchema).max(200).default([]),
      weekdays: z.array(z.enum(WEEKDAYS)).max(7).optional().describe('Also add it to these weekdays of the weekly plan'),
      request_id: requestIdSchema,
      reason: reasonSchema
    },
    handler: async ({ name, icon, progression, exclude_from_progression, exercises = [], weekdays = [], request_id, reason }) => {
      const id = uid()      // before the write: a retried write must create the same routine, once
      let out
      const res = await writer.commit('create_routine', S => {
        const routine = { id, name, emoji: icon || DEFAULT_ICON, ...(progression ? { prog: progression } : {}), ...(exclude_from_progression ? { excludeFromProgression: true } : {}), ex: [] }
        routine.ex = buildExercises(exercises, routine, S)
        S.routines = Array.isArray(S.routines) ? S.routines : []
        S.routines.push(routine)                                   // Plan.jsx addRoutine
        S.week = S.week && typeof S.week === 'object' ? S.week : {}
        for (const day of weekdays) {
          const d = String(WEEKDAYS.indexOf(day))
          const cur = [].concat(S.week[d] || [])
          if (!cur.includes(id)) S.week[d] = [...cur, id]
        }
        out = { ...view(routine, S), weekdays }
        return S
      }, { reason, requestId: request_id, meta: { routine_id: id } })
      if (res.duplicate) return { ok: true, duplicate: true, change_id: res.change_id, ...res.meta }
      return result(res, out)
    }
  }

  const updateRoutine = {
    name: 'update_routine',
    description: 'Change a routine. Only the fields given change. `exercises`, when given, REPLACES the whole list — to edit one exercise, get_routine, change it, and send the full list back (keep the order and superset_group labels you want). progression null makes the routine follow the default rule again.',
    schema: {
      routine_id: z.string().min(1),
      name: z.string().trim().min(1).max(200).optional(),
      icon: z.enum(ICONS).optional(),
      progression: z.enum(ROUTINE_RULES).nullable().optional(),
      exclude_from_progression: z.boolean().optional(),
      exercises: z.array(exerciseSchema).max(200).optional(),
      reason: reasonSchema
    },
    handler: async ({ routine_id, name, icon, progression, exclude_from_progression, exercises, reason }) => {
      let out
      const res = await writer.commit('update_routine', S => {
        const r = findRoutine(S, routine_id)
        if (name !== undefined) r.name = name
        if (icon !== undefined) r.emoji = icon
        if (progression === null) delete r.prog
        else if (progression !== undefined) r.prog = progression
        // RoutineEdit.jsx:364-367 — written only when true.
        if (exclude_from_progression === true) r.excludeFromProgression = true
        else if (exclude_from_progression === false) delete r.excludeFromProgression
        if (exercises !== undefined) r.ex = buildExercises(exercises, r, S, r.ex || [])
        out = view(r, S)
        return S
      }, { reason })
      return result(res, out)
    }
  }

  const deleteRoutine = {
    name: 'delete_routine',
    description: 'Delete a routine and take it off the weekly plan and any date overrides. Logged workouts are history and stay. Undoable with undo_last_change.',
    schema: { routine_id: z.string().min(1), reason: reasonSchema },
    handler: async ({ routine_id, reason }) => {
      let name
      const res = await writer.commit('delete_routine', S => {
        name = findRoutine(S, routine_id).name
        // RoutineEdit.jsx:451-458, verbatim in effect.
        S.routines = S.routines.filter(x => x.id !== routine_id)
        for (const k of Object.keys(S.week || {})) {
          const next = [].concat(S.week[k]).filter(rid => rid !== routine_id)
          if (next.length) S.week[k] = next
          else delete S.week[k]
        }
        for (const k of Object.keys(S.dayPlan || {})) if (S.dayPlan[k] === routine_id) delete S.dayPlan[k]
        return S
      }, { reason })
      return result(res, { deleted: { routine_id, name } })
    }
  }

  const reorderRoutines = {
    name: 'reorder_routines',
    description: 'Set the order routines are listed in (the Plan screen\'s order). Pass every routine id exactly once.',
    schema: { routine_ids: z.array(z.string().min(1)).min(1).max(100), reason: reasonSchema },
    handler: async ({ routine_ids, reason }) => {
      let order
      const res = await writer.commit('reorder_routines', S => {
        const have = (S.routines || []).map(r => r.id)
        const want = [...new Set(routine_ids)]
        if (want.length !== routine_ids.length || want.length !== have.length || !have.every(id => want.includes(id))) {
          throw toolError('EINVALID', `routine_ids must list every routine exactly once: ${have.join(', ')}`)
        }
        const byId = new Map(S.routines.map(r => [r.id, r]))
        S.routines = want.map(id => byId.get(id))
        order = S.routines.map(r => r.name)
        return S
      }, { reason })
      return result(res, { order })
    }
  }

  return [createRoutine, updateRoutine, deleteRoutine, reorderRoutines]
}
