/* Logging and deleting workouts. log_workout builds the same session object the app's start
   screen would (buildCombinedEntries for the routines' targets and ids), fills in the sets that
   were done, and finishes it through finishSession (frontend/src/lib/finish-workout.js) — the
   one function behind the app's Finish button — so PRs, working weights and filing are decided
   exactly as the app decides them. */
import { z } from 'zod'
import { toolError } from './writer.js'
import { exerciseExists, isIsoDate } from './invariants.js'
import { todayFor, zoneFor, zonedEpoch } from './edit-tools.js'
import { finishSession } from '../../frontend/src/lib/finish-workout.js'
import { buildCombinedEntries, deriveSessionName } from '../../frontend/src/lib/session-merge.js'
import { registerCustom, isCardio, EXIDX, exOr } from '../../frontend/src/lib/exercises.js'
import { exerciseMuscleSnapshot } from '../../frontend/src/lib/muscles.js'
import { modeOf } from '../../frontend/src/lib/history.js'
import { uid } from '../../frontend/src/lib/format.js'

const reasonSchema = z.string().max(300).optional().describe('Why — kept in the change history next to the change')

const setSchema = z.object({
  weight: z.number().min(0).max(10000).optional().describe('Load in the profile unit (added weight on a bodyweight exercise)'),
  reps: z.number().int().min(0).max(10000).optional(),
  seconds: z.number().int().min(1).max(36000).optional().describe('Timed sets (holds, carries)'),
  minutes: z.number().min(0.1).max(1440).optional().describe('Cardio'),
  speed: z.number().min(0).max(60).optional().describe('Cardio, km/h'),
  warmup: z.boolean().optional().describe('A warm-up set: never a record, never counted as work'),
  rir: z.number().min(0).max(10).optional().describe('Reps in reserve'),
  rpe: z.number().min(1).max(10).optional().describe('Rate of perceived exertion')
})

// A set row as the workout screen stores a checked-off set (workout-model.js).
function setRow(s, mode, at) {
  if (mode === 'cardio') {
    if (!(s.minutes > 0)) throw toolError('EINVALID', `${at}: a cardio set needs minutes`)
    return { min: s.minutes, speed: s.speed ?? 0, done: true }
  }
  if (mode === 'time') {
    if (!(s.seconds > 0)) throw toolError('EINVALID', `${at}: a timed set needs seconds`)
    return { sec: s.seconds, w: s.weight ?? 0, done: true, ...(s.warmup ? { phase: 'warmup' } : {}) }
  }
  if (s.reps == null) throw toolError('EINVALID', `${at}: a set needs reps (or seconds for a timed exercise, minutes for cardio)`)
  return {
    w: s.weight ?? 0, r: s.reps, done: true,
    ...(s.warmup ? { phase: 'warmup' } : {}),
    ...(s.rir != null ? { rir: s.rir } : {}),
    ...(s.rpe != null ? { rpe: s.rpe } : {})
  }
}

export function workoutTools(writer) {
  const logWorkout = {
    name: 'log_workout',
    description: 'Log a workout that was done — the sets actually performed, like finishing a session in the app. PRs, working weights and where it is filed follow the app\'s own rules: the newest workout counts for PRs and raises working weights; one dated before another (or before today, or replacing one) is filed into history without claiming records or moving weights. To correct a logged workout, log it again with on_same_day "replace". Giving bodyweight also records that day\'s weigh-in, as the app\'s start-of-workout weigh-in does.',
    schema: {
      date: z.string().optional().describe('YYYY-MM-DD, default today in the athlete\'s time zone; not in the future'),
      start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('HH:MM local; default: just finished (today) or 18:00 (a past day)'),
      duration_min: z.number().int().min(1).max(600).default(60),
      routine_ids: z.array(z.string().min(1)).max(5).optional().describe('The routines this session trained (their targets and progression apply). Omit for a freestyle session.'),
      name: z.string().trim().min(1).max(60).optional().describe('Default: the routines\' names, or Freestyle'),
      bodyweight: z.number().positive().max(1500).optional(),
      note: z.string().max(1000).optional().describe('Session note'),
      entries: z.array(z.object({
        exercise_id: z.string().min(1),
        sets: z.array(setSchema).min(1).max(200),
        note: z.string().max(500).optional()
      })).min(1).max(200),
      on_same_day: z.enum(['error', 'add', 'replace']).default('error').describe('When that date already has a workout: refuse (default), add a second one, or replace it'),
      replace_workout_id: z.string().optional().describe('Which workout to replace when that date has several'),
      request_id: z.string().min(1).max(100).optional()
        .describe('Any unique string: sending the same call again with it returns the first result instead of logging the workout twice'),
      reason: reasonSchema
    },
    handler: async (p) => {
      const wid = uid()               // before the write: a retry must log the same workout, once
      const now = Date.now()
      const dur = p.duration_min ?? 60
      let out
      const res = await writer.commit('log_workout', S => {
        registerCustom(S.customEx || [])
        const today = todayFor(S)
        const iso = p.date || today
        if (!isIsoDate(iso)) throw toolError('EINVALID', `${JSON.stringify(iso)} is not a YYYY-MM-DD date`)
        if (iso > today) throw toolError('EINVALID', 'a workout cannot be logged in the future')
        // Wall-clock times are the athlete's, in the same zone that decided `today` — never the
        // server's own, which would move an 18:00 session by however far apart the two are.
        const zone = zoneFor(S)
        const start = p.start_time ? zonedEpoch(iso, p.start_time, zone) : iso === today ? now - dur * 60000 : zonedEpoch(iso, '18:00', zone)
        if (start > now) throw toolError('EINVALID', 'that start time has not happened yet')

        const wanted = [...new Set(p.routine_ids || [])]
        const { entries: planned, routineIds, routines } = buildCombinedEntries(S, wanted)
        const missing = wanted.filter(id => !routineIds.includes(id))
        if (missing.length) throw toolError('ENOENT', `no routine with id ${missing.join(', ')} — list_routines has the ids`)

        // Same-day handling, as the app's "Log a past workout" asks it (sheets.jsx SameDayChoice).
        const workouts = Array.isArray(S.workouts) ? S.workouts : []
        const sameDay = workouts.filter(w => w.d === iso)
        let replaceId = null
        if (sameDay.length && (p.on_same_day ?? 'error') === 'error') {
          throw toolError('EEXISTS', `${iso} already has ${sameDay.map(w => `"${w.name}" (${w.id})`).join(', ')} — pass on_same_day "add" or "replace"`)
        }
        if (p.on_same_day === 'replace') {
          if (p.replace_workout_id) {
            if (!sameDay.some(w => w.id === p.replace_workout_id)) throw toolError('ENOENT', `no workout ${p.replace_workout_id} on ${iso}`)
            replaceId = p.replace_workout_id
          } else if (sameDay.length === 1) replaceId = sameDay[0].id
          else if (sameDay.length > 1) throw toolError('EINVALID', `${iso} has several workouts — pass replace_workout_id: ${sameDay.map(w => w.id).join(', ')}`)
        }

        // Fill the planned entries with what was done; an exercise the routines did not plan
        // joins as an extra, the way adding one mid-session does.
        const used = new Set()
        const entries = p.entries.map((ie, n) => {
          const at = `entry ${n + 1} (${ie.exercise_id})`
          if (!exerciseExists(ie.exercise_id, S)) throw toolError('EINVALID', `${at}: no such exercise — search_exercises has the ids`)
          const pi = planned.findIndex((e, i) => !used.has(i) && e.id === ie.exercise_id)
          if (pi >= 0) used.add(pi)
          const base = pi >= 0 ? planned[pi] : { id: ie.exercise_id, target: null }
          const mode = base.target ? modeOf({ ...base.target, id: ie.exercise_id })
            : isCardio(ie.exercise_id) ? 'cardio'
              : ie.sets.every(s => s.seconds && s.reps == null) ? 'time' : 'reps'
          return { ...base, id: ie.exercise_id, sets: ie.sets.map((s, k) => setRow(s, mode, `${at} set ${k + 1}`)), ...(ie.note ? { note: ie.note } : {}) }
        })

        // Newest workout: live rules. Anything filed behind another one: past rules.
        const later = workouts.some(w => w.id !== replaceId && (w.d > iso || (w.d === iso && (w.start || 0) > start)))
        const past = iso < today || !!replaceId || later
        const active = {
          id: wid, d: iso, start, routineIds,
          name: p.name || (routines.length ? deriveSessionName(routines.map(r => r.name)) : 'Freestyle'),
          bw: p.bodyweight ?? null, entries,
          ...(p.note ? { note: p.note } : {}),
          ...(past ? { backfill: { durationMin: dur, replaceId } } : {})
        }
        const { workout, prs } = finishSession(S, active, {
          now: start + dur * 60000,
          snapshotFor: e => (EXIDX[e.id] && EXIDX[e.id].custom ? exerciseMuscleSnapshot(EXIDX[e.id]) : null)
        })
        if (p.bodyweight != null) {
          // The start-of-workout weigh-in, as BwSheet saves it (sheets.jsx:210-216).
          const w = Math.round(p.bodyweight * 10) / 10
          S.bodyweight = Array.isArray(S.bodyweight) ? S.bodyweight : []
          const ex = S.bodyweight.find(b => b.d === iso)
          if (ex) { ex.w = w; ex.t = now } else S.bodyweight.push({ d: iso, w, t: now })
          S.bodyweight.sort((a, b) => (a.d < b.d ? -1 : 1))
        }
        out = {
          workout_id: wid, date: iso, name: workout.name, unit: S.unit || 'kg',
          volume: workout.vol, prs: prs.map(id => exOr(id).n),
          filed: past ? 'into history — no records claimed, working weights unchanged' : 'as the newest workout — PRs and working weights updated',
          ...(replaceId ? { replaced: replaceId } : {})
        }
        return S
      }, { reason: p.reason, requestId: p.request_id, meta: { workout_id: wid } })
      if (res.duplicate) return { ok: true, duplicate: true, change_id: res.change_id, ...res.meta }
      return res.changed ? { ok: true, change_id: res.change_id, ...out } : { ok: true, changed: false, ...out }
    }
  }

  const deleteWorkout = {
    name: 'delete_workout',
    description: 'Delete a logged workout (the app\'s delete: the record goes; working weights it raised stay). Undoable with undo_last_change.',
    schema: { workout_id: z.string().min(1), reason: reasonSchema },
    handler: async ({ workout_id, reason }) => {
      let gone
      const res = await writer.commit('delete_workout', S => {
        const w = (S.workouts || []).find(x => x.id === workout_id)
        if (!w) throw toolError('ENOENT', `no workout ${workout_id} — list_workouts has the ids`)
        gone = { workout_id, date: w.d, name: w.name }
        S.workouts = S.workouts.filter(x => x.id !== workout_id)
        return S
      }, { reason })
      return { ok: true, change_id: res.change_id, deleted: gone }
    }
  }

  return [logWorkout, deleteWorkout]
}
