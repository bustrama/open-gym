/* Tools that change the profile, plus the reads they lean on (exercise search, settings).
   Every change goes through writer.commit() — read from the api, mutate, check, conditional
   write, journal — so each one is undoable and none can race a phone. The mutations do what the
   app's own sheets do, field for field; the file:line after each points at the code it mirrors.

   Weights are always in the profile's own unit (`unit` in every answer): kg/lb is the one
   setting left to the app, because changing it converts every stored weight. */
import { z } from 'zod'
import { getState } from './state.js'
import { toolError } from './writer.js'
import { applyUndo, summarize, statusOf } from './journal.js'
import { isIsoDate } from './invariants.js'
import { allExercises, searchExercises, smOf, BODYPARTS } from '../../frontend/src/lib/exercises.js'
import { ACCENTS } from '../../frontend/src/lib/format.js'

/* ---------- helpers ---------- */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const weekdaySchema = z.union([z.number().int().min(0).max(6), z.enum(WEEKDAYS)])
  .describe('0 = Sunday … 6 = Saturday, or the day\'s English name')
const weekdayIndex = v => (typeof v === 'number' ? v : WEEKDAYS.indexOf(v))
const reasonSchema = z.string().max(300).optional().describe('Why — kept in the change history next to the change')

// The athlete's zone: what their browser reported with the reminder settings, else the
// container's TZ, else the zone this machine runs in. The one answer used both for "today" and
// for turning a wall-clock start time into an instant, so a date and its start never disagree.
export function zoneFor(S) {
  const candidates = [S && S.reminder && S.reminder.tz, process.env.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone]
  for (const z of candidates) {
    if (!z) continue
    try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z } catch { /* not a zone name */ }
  }
  return 'UTC'
}

export function todayFor(S, now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zoneFor(S), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
}

// Epoch of a wall-clock time on a date in `zone`: read that wall clock as UTC, then correct by the
// zone's offset at that instant — twice, so a daylight-saving change in between settles.
export function zonedEpoch(iso, time, zone) {
  const [y, mo, d] = iso.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const want = Date.UTC(y, mo - 1, d, h, mi)
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
  let t = want
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, x.value]))
    t += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute)
  }
  return t
}

const round1 = n => Math.round(n * 10) / 10
const routineName = (S, id) => ((S.routines || []).find(r => r.id === id) || {}).name || id
const weekView = S => Object.fromEntries(WEEKDAYS.map((name, i) => [name, [].concat((S.week || {})[i] || []).map(id => routineName(S, id))]))

function result(res, extra) {
  return res.changed
    ? { ok: true, change_id: res.change_id, changes: res.changes, ...extra }
    : { ok: true, changed: false, note: 'already like that — nothing was written', ...extra }
}

function needRoutine(S, id) {
  if (!(S.routines || []).some(r => r.id === id)) throw toolError('ENOENT', `no routine with id ${JSON.stringify(id)} — list_routines has the ids`)
}

/* ---------- settings ---------- */

// Settings a tool may read and write, snake_case outside, the store's names inside
// (frontend/src/store/useStore.js DEF). `unit` is read-only here.
const SETTINGS = {
  rest_sec: ['restSec', z.number().int().min(0).max(1800), 'Default rest between sets, seconds'],
  rest_pause_sec: ['restPauseSec', z.number().int().min(1).max(600), 'Rest inside a rest-pause set, seconds'],
  sound: ['sound', z.boolean(), 'Timer sound'],
  sound_on_silent: ['soundOnSilent', z.boolean(), 'Play the timer sound even with the phone on silent'],
  timer_flash: ['timerFlash', z.boolean(), 'Flash the screen when rest is over'],
  keep_awake: ['keepAwake', z.boolean(), 'Keep the screen on during a workout'],
  lang: ['lang', z.enum(['en', 'de', 'es', 'fr', 'hi', 'hu', 'it', 'ko', 'pl', 'pt', 'pt-BR', 'ru', 'th', 'tr', 'zh']), 'App language'],
  theme: ['theme', z.enum(['dark', 'light', 'system']), 'Colour theme'],
  accent: ['accent', z.enum(Object.keys(ACCENTS)), 'Accent colour'],
  body: ['body', z.enum(['male', 'female']), 'Body figure on the muscle map'],
  gif_size: ['gifSize', z.enum(['full', 'mini', 'off']), 'Exercise animation size during a workout'],
  workout_view: ['workoutView', z.enum(['cards', 'list', 'compact']), 'Workout screen layout'],
  effort: ['effort', z.enum(['none', 'rir', 'rpe']), 'Per-set effort scale that is logged'],
  week_start: ['weekStart', z.union([z.literal(0), z.literal(1)]), 'First day of the week: 1 Monday, 0 Sunday'],
  weight_decimals: ['wdec', z.union([z.literal(1), z.literal(2)]), 'Decimals shown on weights'],
  weigh_in_before_workout: ['weighIn', z.boolean(), 'Ask for body weight when a workout starts'],
  gym_check_in: ['checkIn', z.boolean(), 'Show the gym check-in card']
}

function settingsView(S) {
  const out = { unit: S.unit || 'kg' }
  for (const [k, [field]] of Object.entries(SETTINGS)) out[k] = S[field] === undefined ? null : S[field]
  const rem = S.reminder || {}
  out.reminder = { on: !!rem.on, time: rem.time || '08:00', timezone: rem.tz || null }
  out.goal_weight = S.targetW == null ? null : S.targetW
  return out
}

/* ---------- read tools (always on) ---------- */

export const searchExercisesTool = {
  name: 'search_exercises',
  description: 'Search the exercise library (1,300+ built-in exercises plus the athlete\'s custom ones) by name, muscle or equipment. Use the returned id wherever a routine needs an exercise.',
  schema: {
    query: z.string().min(1).max(80).describe('Words to match, e.g. "incline dumbbell press" or "hamstring"'),
    body_part: z.enum(BODYPARTS).optional().describe('Only exercises for this body part'),
    limit: z.number().int().min(1).max(50).default(15)
  },
  handler: ({ query, body_part, limit = 15 }) => {
    const S = getState() || {}
    let list = allExercises(S)
    if (body_part) list = list.filter(e => e.bp === body_part)
    const hits = searchExercises(list, query)
    return {
      total: hits.length,
      exercises: hits.slice(0, limit).map(e => ({
        id: e.id, name: e.n, body_part: e.bp || null, equipment: e.eq || null, target: e.tg || null,
        secondary: smOf(e), custom: !!e.custom,
        // What upsert_custom_exercise takes, so a custom exercise can be read and edited back.
        ...(Array.isArray(e.primaries) ? { primary_muscles: e.primaries } : {}),
        ...(e.custom && Array.isArray(e.secondaries) ? { secondary_muscles: e.secondaries } : {}),
        ...(e.desc ? { description: e.desc } : {})
      }))
    }
  }
}

export const getSettings = {
  name: 'get_settings',
  description: 'The app settings: unit, rest timer, sounds, language, theme, workout layout, effort scale, reminder, goal weight.',
  schema: {},
  handler: () => {
    const S = getState()
    if (!S) return { error: 'no synced state yet' }
    return settingsView(S)
  }
}

export const READ_TOOLS = [searchExercisesTool, getSettings]

/* ---------- write tools (OPENGYM_MCP_WRITE) ---------- */

export function writeTools(writer) {
  const updateSettings = {
    name: 'update_settings',
    description: 'Change app settings. Only the fields given are changed. The unit (kg/lb) cannot be changed here: it converts every stored weight and is left to the app.',
    schema: {
      ...Object.fromEntries(Object.entries(SETTINGS).map(([k, [, type, desc]]) => [k, type.optional().describe(desc)])),
      reminder_on: z.boolean().optional().describe('Workout-day reminder notification on/off'),
      reminder_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('Reminder time, HH:MM in the athlete\'s time zone'),
      unit: z.string().optional().describe('Not changeable here — see description'),
      reason: reasonSchema
    },
    handler: async params => {
      if (params.unit !== undefined) throw toolError('EREFUSED', 'the unit is changed in the app (Settings → Units): switching kg/lb converts every stored weight, including a workout in progress on the phone')
      let view
      const res = await writer.commit('update_settings', S => {
        for (const [k, [field]] of Object.entries(SETTINGS)) {
          if (params[k] === undefined) continue
          S[field] = params[k]
          if (k === 'effort') delete S.showRir            // Settings.jsx:341
        }
        if (params.reminder_on !== undefined || params.reminder_time !== undefined) {
          // The zone stays whatever the athlete's browser reported; a profile that has none yet
          // gets the athlete's zone, as a device would stamp it — without one the server's
          // reminder tick would fire at UTC wall time.
          const rem = S.reminder || { on: false, time: '08:00', tz: null }
          S.reminder = {
            ...rem,
            ...(params.reminder_on !== undefined ? { on: params.reminder_on } : {}),
            ...(params.reminder_time ? { time: params.reminder_time } : {}),
            tz: rem.tz || zoneFor(S)
          }
        }
        view = settingsView(S)
        return S
      }, { reason: params.reason })
      return result(res, { settings: view })
    }
  }

  const logBodyweight = {
    name: 'log_bodyweight',
    description: 'Log a weigh-in (one per day; logging a day that has one replaces it). Weight is in the profile\'s unit, rounded to 0.1 like the app does.',
    schema: {
      weight: z.number().positive().max(1500),
      date: z.string().optional().describe('YYYY-MM-DD, default today in the athlete\'s time zone. Not in the future.'),
      reason: reasonSchema
    },
    handler: async ({ weight, date, reason }) => {
      const w = round1(weight)
      const now = Date.now()   // outside the mutation: a retried write must stamp the same `t`
      let iso, unit
      const res = await writer.commit('log_bodyweight', S => {
        iso = date || todayFor(S)
        unit = S.unit || 'kg'
        if (!isIsoDate(iso)) throw toolError('EINVALID', `${JSON.stringify(iso)} is not a YYYY-MM-DD date`)
        if (iso > todayFor(S)) throw toolError('EINVALID', 'a weigh-in cannot be in the future')
        S.bodyweight = Array.isArray(S.bodyweight) ? S.bodyweight : []
        // BwSheet save — sheets.jsx:210-216
        const ex = S.bodyweight.find(b => b.d === iso)
        if (ex) { if (ex.w === w) return S; ex.w = w; ex.t = now } else S.bodyweight.push({ d: iso, w, t: now })
        S.bodyweight.sort((a, b) => (a.d < b.d ? -1 : 1))
        return S
      }, { reason })
      return result(res, { date: iso, weight: w, unit })
    }
  }

  const deleteBodyweight = {
    name: 'delete_bodyweight',
    description: 'Delete the weigh-in of one day.',
    schema: { date: z.string().describe('YYYY-MM-DD'), reason: reasonSchema },
    handler: async ({ date, reason }) => {
      const res = await writer.commit('delete_bodyweight', S => {
        const bw = Array.isArray(S.bodyweight) ? S.bodyweight : []
        if (!bw.some(b => b.d === date)) throw toolError('ENOENT', `no weigh-in on ${date}`)
        S.bodyweight = bw.filter(b => b.d !== date)             // sheets.jsx:218
        return S
      }, { reason })
      return result(res, { date })
    }
  }

  const setGoalWeight = {
    name: 'set_goal_weight',
    description: 'Set the goal body weight drawn on the weight charts (profile unit, rounded to 0.1), or null to remove it.',
    schema: { weight: z.number().positive().max(1500).nullable(), reason: reasonSchema },
    handler: async ({ weight, reason }) => {
      const w = weight == null ? null : round1(weight)
      let unit
      const res = await writer.commit('set_goal_weight', S => {
        unit = S.unit || 'kg'
        S.targetW = w                                           // GoalSheet — sheets.jsx:566-571
        return S
      }, { reason })
      return result(res, { goal_weight: w, unit })
    }
  }

  const setWeekPlan = {
    name: 'set_week_plan',
    description: 'Set which routines are scheduled on a weekday, for every week. mode "replace" sets the day to exactly routine_ids (an empty list makes it a rest day); "add" appends; "remove" takes the given routines off. A day can hold several routines, trained as one combined session.',
    schema: {
      weekday: weekdaySchema,
      routine_ids: z.array(z.string().min(1)).max(10),
      mode: z.enum(['replace', 'add', 'remove']).default('replace'),
      reason: reasonSchema
    },
    handler: async ({ weekday, routine_ids, mode = 'replace', reason }) => {
      const d = String(weekdayIndex(weekday))
      let week
      const res = await writer.commit('set_week_plan', S => {
        if (mode !== 'remove') for (const id of routine_ids) needRoutine(S, id)
        S.week = S.week && typeof S.week === 'object' ? S.week : {}
        const cur = [].concat(S.week[d] || [])
        const next = mode === 'replace' ? [...new Set(routine_ids)]
          : mode === 'add' ? [...cur, ...routine_ids.filter((id, i) => !cur.includes(id) && routine_ids.indexOf(id) === i)]
            : cur.filter(id => !routine_ids.includes(id))
        // A day holds a routine-id list; a rest day is a missing key, never [] (sheets.jsx:1628,1647).
        if (next.length) S.week[d] = next
        else delete S.week[d]
        week = weekView(S)
        return S
      }, { reason })
      return result(res, { week })
    }
  }

  const setDayOverride = {
    name: 'set_day_override',
    description: 'Change what is trained on one date without touching the weekly plan: a routine id, "rest", or null to go back to the weekly plan for that date.',
    schema: {
      date: z.string().describe('YYYY-MM-DD'),
      routine: z.string().min(1).nullable().describe('A routine id, "rest", or null'),
      reason: reasonSchema
    },
    handler: async ({ date, routine, reason }) => {
      if (!isIsoDate(date)) throw toolError('EINVALID', `${JSON.stringify(date)} is not a YYYY-MM-DD date`)
      const res = await writer.commit('set_day_override', S => {
        S.dayPlan = S.dayPlan && typeof S.dayPlan === 'object' ? S.dayPlan : {}
        // DayOverride — sheets.jsx:1603
        if (routine == null) delete S.dayPlan[date]
        else {
          if (routine !== 'rest') needRoutine(S, routine)
          S.dayPlan[date] = routine
        }
        return S
      }, { reason })
      return result(res, { date, planned: routine == null ? 'weekly plan' : routine })
    }
  }

  const listRecentChanges = {
    name: 'list_recent_changes',
    description: 'The changes made through this MCP server, newest first, with their change_id for undo_last_change. `status` says whether each is still in effect: "changed since" means the athlete (or a device syncing an older copy, e.g. mid-workout) has changed the same thing afterwards — check before assuming an edit stuck.',
    schema: { limit: z.number().int().min(1).max(50).default(10) },
    handler: async ({ limit = 10 }) => {
      const { state } = await writer.read()
      return {
        changes: writer.journal.list(limit).map(e => ({
          change_id: e.id,
          when: new Date(e.ts).toISOString(),
          tool: e.op,
          reason: e.reason,
          changes: summarize(e.patches),
          status: e.undone_by ? 'undone' : state ? statusOf(e.patches, state) : 'unknown',
          undo_of: e.undoes || null
        }))
      }
    }
  }

  const undoLastChange = {
    name: 'undo_last_change',
    description: 'Undo the newest change made through this MCP server (or the one named by change_id). Only what that change touched is put back; if the athlete or a device has changed the same thing since, it refuses and says what — pass force to undo anyway. An undo is itself a change and can be undone.',
    schema: {
      change_id: z.string().optional(),
      force: z.boolean().default(false),
      reason: reasonSchema
    },
    handler: async ({ change_id, force = false, reason }) => {
      const target = change_id ? writer.journal.get(change_id) : writer.journal.latest()
      if (!target) throw toolError('ENOENT', change_id ? `no change ${change_id} in the history` : 'nothing to undo')
      if (target.undone_by) throw toolError('EINVALID', `change ${target.id} was already undone by ${target.undone_by}`)
      const res = await writer.commit('undo_last_change', S => applyUndo(S, target.patches, { force }), {
        reason: reason || `undo ${target.op}`, undoes: target.id
      })
      return result(res, { undid: { change_id: target.id, tool: target.op } })
    }
  }

  return [updateSettings, logBodyweight, deleteBodyweight, setGoalWeight, setWeekPlan, setDayOverride, listRecentChanges, undoLastChange]
}
