// The rest timer on an Android phone's status bar and lock screen, and the alert when it is over.
// The browser gets these from Web Push; the app, which has no push, posts two notifications of
// its own:
//   - a silent, ongoing one whose chronometer counts down to the end of the rest (the RestTimer
//     plugin, android/app/src/main/java/ch/duartesantos/opengym/RestTimerPlugin.java). It
//     removes itself when the rest is over.
//   - a one-off local notification at the end, on a channel that sounds and vibrates. A watch
//     that mirrors the phone's notifications buzzes with this one.
// Both follow the rest: replaced when it changes, cancelled when it ends early. Nothing here runs
// outside the Android app, or with the switch in Settings (S.restNotify) off.

import { MOBILE, isAndroid } from './mobile.js'
import { t, exerciseNameFor } from './i18n.js'
import { exOr } from './exercises.js'
import { capWords } from './format.js'
import { supersetUnits } from './history.js'
import { upNextAfterRest } from './active-workout-order.js'

export const REST_ALERT_ID = 7101
const ALERT_CHANNEL = 'rest-over'
const ICON = 'ic_stat_opengym'

// Every call goes through one queue: a rest skipped while its notifications are still being
// posted must not leave an alert behind that was scheduled after the cancel. Each call resolves
// with what its job answered, and a job that throws answers { shown: false, reason }: nothing
// here may reach the workout, but a failure must not vanish without a word either.
let queue = Promise.resolve()
const errText = e => String((e && (e.message || e.code)) || e || 'error')
const run = job => (queue = queue.then(job).catch(e => ({ shown: false, reason: errText(e) })))
const idle = () => queue.then(() => null)

let plugins = null
const load = async () => {
  if (!plugins) {
    const [{ registerPlugin }, { LocalNotifications }] = await Promise.all([import('@capacitor/core'), import('@capacitor/local-notifications')])
    plugins = { RestTimer: registerPlugin('RestTimer'), LocalNotifications, channel: false }
  }
  return plugins
}

// What the rest is for: the exercise you are between sets of, or, once it is finished, the one
// that comes next.
export function restText(active, forIdx) {
  const entries = active?.entries || []
  const name = i => capWords(exerciseNameFor(exOr(entries[i].id)))
  const next = upNextAfterRest(active, forIdx)
  if (next) return t('Up next: {0}', next.map(name).join(' + '))
  const own = Number.isInteger(forIdx) && entries[forIdx] ? supersetUnits(entries).find(unit => unit.includes(forIdx)) : null
  return own ? own.map(name).join(' + ') : ''
}

// Resolves with the RestTimer plugin's answer, { shown, reason? }, plus alertError when the alert
// at the end could not be scheduled; null where nothing ran (the switch off, not Android).
export function showRest(S, { endsAt, text = '' }) {
  if (!MOBILE || !S?.restNotify) return idle()
  return run(async () => {
    if (!(await isAndroid())) return null
    const p = await load()
    // The countdown and the alert stand apart: either channel can be turned off on its own in
    // Android's settings, and a countdown that fails must not take the alert down with it.
    let result
    try {
      result = (await p.RestTimer.start({ endsAt, title: t('Rest'), text, channelName: t('Rest timer') })) || { shown: false, reason: 'no answer' }
    } catch (e) { result = { shown: false, reason: errText(e) } }
    try {
      if (!p.channel) {
        await p.LocalNotifications.createChannel({ id: ALERT_CHANNEL, name: t('Rest over'), importance: 5, visibility: 1, vibration: true })
        p.channel = true
      }
      await p.LocalNotifications.cancel({ notifications: [{ id: REST_ALERT_ID }] })
      await p.LocalNotifications.schedule({ notifications: [{
        id: REST_ALERT_ID,
        title: t('Rest over — next set!'),
        body: text,
        channelId: ALERT_CHANNEL,
        smallIcon: ICON,
        autoCancel: true,
        schedule: { at: new Date(endsAt), allowWhileIdle: true },
      }] })
    } catch (e) { result = { ...result, alertError: errText(e) } }
    return result
  })
}

// What to tell the user about a showRest() answer, or null when there is nothing to say.
export function restProblem(r) {
  if (!r) return null
  if (r.shown === false && r.reason !== 'over') {
    if (r.reason === 'notifications-off' || r.reason === 'channel-off') return t('Rest timer notifications are turned off in Android settings.')
    return t('The rest timer could not be shown ({0}).', r.reason || '?')
  }
  if (r.alertError) return t('The rest timer could not be shown ({0}).', r.alertError)
  return null
}

// What Android has up (RestTimerPlugin.status): { enabled, channel, active, promotable,
// promoted, canPromote, sdk }; null off Android.
export function restStatus() {
  if (!MOBILE) return idle()
  return run(async () => {
    if (!(await isAndroid())) return null
    return (await load()).RestTimer.status()
  })
}

const statusText = st => `notifications ${st.enabled ? 'on' : 'off'}, channel ${st.channel ?? '?'}, SDK ${st.sdk ?? '?'}`

// Settings' "Test rest notifications": a short rest, countdown and alert, then a look at what
// Android actually has up. notify() posts asynchronously, hence the pause before the look.
export async function testRest(S, { seconds = 10, text = '', settle = 1000 } = {}) {
  const r = await showRest({ ...S, restNotify: true }, { endsAt: Date.now() + seconds * 1000, text })
  if (!r || r.shown === false || r.alertError) return r
  await new Promise(done => setTimeout(done, settle))
  const st = await restStatus()
  if (st && st.active === false) return { shown: false, reason: `not showing: ${statusText(st)}`, status: st }
  return { ...r, status: st }
}

// keepAlert: the rest ran out while nobody was watching the app, so the alert at its end is the
// one thing that tells them. Everywhere else it goes too.
export function clearRest({ keepAlert = false } = {}) {
  if (!MOBILE) return idle()
  return run(async () => {
    if (!(await isAndroid())) return null
    const p = await load()
    await p.RestTimer.stop()
    if (!keepAlert) await p.LocalNotifications.cancel({ notifications: [{ id: REST_ALERT_ID }] })
    return null
  })
}

// The Settings switch: asks for the notification permission, the only place that does.
export async function allowRestNotify() {
  try {
    const { LocalNotifications } = await load()
    let perm = await LocalNotifications.checkPermissions()
    if (perm.display !== 'granted') perm = await LocalNotifications.requestPermissions()
    return perm.display === 'granted'
  } catch { return false }
}
