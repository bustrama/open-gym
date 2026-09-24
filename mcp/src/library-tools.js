/* The exercise library's personal side: custom exercises, standing notes, favourites and bar
   weights. Each does what the app's own sheet does (sheets.jsx CustomExForm / deleteCustomEx,
   the exercise note sheet, BarWeightEditor, lib/favourites.js) — same shape, same cascade. */
import { z } from 'zod'
import { toolError } from './writer.js'
import { exerciseExists } from './invariants.js'
import { allExercises, BODYPARTS, EXDB, registerCustom, EXIDX } from '../../frontend/src/lib/exercises.js'
import { MUSCLES, inMuscleOrder, exerciseMuscleSnapshot } from '../../frontend/src/lib/muscles.js'
import { cleanupSg } from '../../frontend/src/lib/history.js'
import { uid } from '../../frontend/src/lib/format.js'

// lib/equipment.js ALL_EQUIPMENT, derived the same way — that module pulls in the Vite-only
// i18n.js and cannot load under plain node.
const EQUIPMENT = (() => {
  const c = {}
  EXDB.forEach(e => { if (e.eq) c[e.eq] = (c[e.eq] || 0) + 1 })
  return Object.keys(c).sort((a, b) => c[b] - c[a] || (a < b ? -1 : 1))
})()
const reasonSchema = z.string().max(300).optional().describe('Why — kept in the change history next to the change')

function result(res, extra) {
  return res.changed
    ? { ok: true, change_id: res.change_id, changes: res.changes, ...extra }
    : { ok: true, changed: false, note: 'already like that — nothing was written', ...extra }
}

function needExercise(S, id) {
  if (!exerciseExists(id, S)) throw toolError('ENOENT', `no exercise ${JSON.stringify(id)} — search_exercises has the ids`)
}

export function libraryTools(writer) {
  const upsertCustomExercise = {
    name: 'upsert_custom_exercise',
    description: 'Create an exercise of the athlete\'s own (name, body_part and equipment required), or edit one by exercise_id — an edit changes only the fields given, like the app\'s form, which starts from what is saved (search_exercises shows a custom exercise\'s current fields). It then works everywhere a library exercise does. Names are unique across the whole library. Cardio exercises log time and speed instead of weight × reps.',
    schema: {
      exercise_id: z.string().regex(/^c[A-Za-z0-9]+$/).optional().describe('A custom exercise to edit; omit to create one'),
      name: z.string().trim().min(1).max(80).optional(),
      body_part: z.enum(BODYPARTS).optional(),
      equipment: z.enum(EQUIPMENT).optional(),
      primary_muscles: z.array(z.enum(MUSCLES)).max(MUSCLES.length).optional().describe('The first is the exercise\'s main target'),
      secondary_muscles: z.array(z.enum(MUSCLES)).max(MUSCLES.length).optional(),
      description: z.string().max(1000).optional().describe('Setup, cues'),
      request_id: z.string().min(1).max(100).optional()
        .describe('Any unique string: sending the same call again with it returns the first result instead of creating a second exercise'),
      reason: reasonSchema
    },
    handler: async ({ exercise_id, name, body_part, equipment, primary_muscles, secondary_muscles, description, request_id, reason }) => {
      if (!exercise_id && (!name || !body_part || !equipment)) throw toolError('EINVALID', 'a new exercise needs name, body_part and equipment')
      const id = exercise_id || 'c' + uid()     // before the write, so a retry creates it once
      let created, finalName
      const res = await writer.commit('upsert_custom_exercise', S => {
        const existing = exercise_id ? (S.customEx || []).find(x => x.id === exercise_id) : null
        if (exercise_id && !existing) throw toolError('ENOENT', `no custom exercise ${exercise_id}`)
        created = !existing
        // What the form would hold: the saved values, with whatever was given on top.
        const n = name ?? existing.n
        const bp = body_part ?? existing.bp
        const eq = equipment ?? existing.eq
        const primaries = primary_muscles ?? (existing ? (existing.primaries || []).filter(m => m !== 'cardiovascular system') : [])
        const secondaries = secondary_muscles ?? (existing ? existing.secondaries || existing.sm || [] : [])
        const desc = description ?? (existing ? existing.desc || '' : '')
        finalName = n
        // CustomExForm save — sheets.jsx:818-846.
        const dup = allExercises(S).find(e => e.n.toLowerCase() === n.toLowerCase() && e.id !== id)
        if (dup) throw toolError('EEXISTS', `"${dup.n}" already exists (${dup.id})`)
        const prim = bp === 'cardio' ? ['cardiovascular system'] : inMuscleOrder(primaries)
        const sm = inMuscleOrder(secondaries.filter(m => !prim.includes(m)))
        const groups = [...prim, ...sm]
        // The main target: kept while it is still a primary, else the first primary given.
        const tg = (existing && prim.includes(existing.tg)) ? existing.tg : (primaries.find(m => prim.includes(m)) || prim[0] || '')
        const fields = { n, bp, desc: desc.trim().slice(0, 1000), tg, sm, muscleGroups: groups, primaries: prim, secondaries: sm, eq }
        if (existing) Object.assign(existing, fields)
        else (S.customEx = Array.isArray(S.customEx) ? S.customEx : []).push({ id, ...fields, custom: true })
        return S
      }, { reason, requestId: request_id, meta: { exercise_id: id } })
      if (res.duplicate) return { ok: true, duplicate: true, change_id: res.change_id, ...res.meta }
      return result(res, { exercise_id: id, name: finalName, created })
    }
  }

  const deleteCustomExercise = {
    name: 'delete_custom_exercise',
    description: 'Delete a custom exercise: it leaves the athlete\'s routines, working weights and favourites; logged workouts keep their sets and its name. If a phone has a workout with it in progress, that should be finished first.',
    schema: { exercise_id: z.string().regex(/^c[A-Za-z0-9]+$/), reason: reasonSchema },
    handler: async ({ exercise_id, reason }) => {
      let name
      const res = await writer.commit('delete_custom_exercise', S => {
        const ex = (S.customEx || []).find(x => x.id === exercise_id)
        if (!ex) throw toolError('ENOENT', `no custom exercise ${exercise_id}`)
        name = ex.n
        registerCustom(S.customEx)
        // deleteCustomEx — sheets.jsx:884-897: history keeps the name and muscles first.
        const snapshot = exerciseMuscleSnapshot(EXIDX[ex.id] || ex)
        for (const w of S.workouts || []) for (const e of w.entries || []) {
          if (e.id !== ex.id) continue
          e.n = ex.n
          if (!e.muscleSnapshot || !Object.keys(e.muscleSnapshot).length) e.muscleSnapshot = snapshot
        }
        S.customEx = S.customEx.filter(x => x.id !== ex.id)
        for (const r of S.routines || []) { r.ex = (r.ex || []).filter(e => e.id !== ex.id); cleanupSg(r.ex) }
        if (S.exWeights) delete S.exWeights[ex.id]
        S.favEx = (S.favEx || []).filter(x => x !== ex.id)
        return S
      }, { reason })
      return result(res, { deleted: { exercise_id, name } })
    }
  }

  const setExerciseNote = {
    name: 'set_exercise_note',
    description: 'The standing note on an exercise — gym-specific facts that hold every time ("seat 4, pin 7"), shown whenever it is trained. An empty note removes it.',
    schema: { exercise_id: z.string().min(1), note: z.string().max(500), reason: reasonSchema },
    handler: async ({ exercise_id, note, reason }) => {
      const text = note.trim()
      const res = await writer.commit('set_exercise_note', S => {
        needExercise(S, exercise_id)
        S.exNotes = S.exNotes && typeof S.exNotes === 'object' ? S.exNotes : {}
        if (text) S.exNotes[exercise_id] = text                       // sheets.jsx:2042-2044
        else delete S.exNotes[exercise_id]
        return S
      }, { reason })
      return result(res, { exercise_id, note: text || null })
    }
  }

  const setFavourite = {
    name: 'set_favourite',
    description: 'Mark an exercise as a favourite (it is listed first when picking exercises), or unmark it.',
    schema: { exercise_id: z.string().min(1), favourite: z.boolean(), reason: reasonSchema },
    handler: async ({ exercise_id, favourite, reason }) => {
      const res = await writer.commit('set_favourite', S => {
        needExercise(S, exercise_id)
        const list = Array.isArray(S.favEx) ? S.favEx : []                // lib/favourites.js
        S.favEx = favourite ? (list.includes(exercise_id) ? list : [...list, exercise_id]) : list.filter(x => x !== exercise_id)
        return S
      }, { reason })
      return result(res, { exercise_id, favourite })
    }
  }

  const setBarWeight = {
    name: 'set_bar_weight',
    description: 'The bar\'s own weight for an exercise, for the plate math (profile unit). 0 means no bar (e.g. a counterbalanced Smith machine); null goes back to the default for its equipment.',
    schema: { exercise_id: z.string().min(1), bar_weight: z.number().min(0).max(100).nullable(), reason: reasonSchema },
    handler: async ({ exercise_id, bar_weight, reason }) => {
      const n = bar_weight == null ? null : Math.round(bar_weight * 100) / 100
      const res = await writer.commit('set_bar_weight', S => {
        needExercise(S, exercise_id)
        S.barWeights = S.barWeights && typeof S.barWeights === 'object' ? S.barWeights : {}
        // BarWeightEditor — sheets.jsx:587-598: a stored 0 is "no bar", no entry is the default.
        if (n == null) delete S.barWeights[exercise_id]
        else S.barWeights[exercise_id] = n
        return S
      }, { reason })
      return result(res, { exercise_id, bar_weight: n })
    }
  }

  return [upsertCustomExercise, deleteCustomExercise, setExerciseNote, setFavourite, setBarWeight]
}
