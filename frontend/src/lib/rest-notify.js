// The rest timer on an Android phone's status bar and lock screen, and the alert when it is over.
// The browser gets these from Web Push; the app, which has no push, posts them itself through the
// RestTimer plugin (android/app/src/main/java/ch/duartesantos/opengym/RestTimer.java):
//   - a silent, ongoing notification whose chronometer counts down to the end of the rest, with
//     −15s, +15s and Skip buttons. It removes itself when the rest is over.
//   - an alert at the end, on a channel that sounds and vibrates. A watch that mirrors the
//     phone's notifications buzzes with this one.
// Both follow the rest: replaced when it changes, cancelled when it ends early. The buttons work
// with the app in the background or not running: the phone moves the countdown and the alert by
// itself and tells the app when it is up (onRestChange). Nothing here runs outside the Android
// app, or with the switch in Settings (S.restNotify) off.

import { MOBILE, isAndroid } from './mobile.js'
import { t, exerciseNameFor } from './i18n.js'
import { exOr } from './exercises.js'
import { capWords } from './format.js'
import { supersetUnits } from './history.js'
import { upNextAfterRest } from './active-workout-order.js'
import { REST_STEP } from './rest-timing.js'

// Every call goes through one queue: a rest skipped while its notifications are still being
// posted must not leave an alert behind that was scheduled after the cancel. Each call resolves
// with what its job answered, and a job that throws answers { shown: false, reason }: nothing
// here may reach the workout, but a failure must not vanish without a word either.
let queue = Promise.resolve()
const errText = e => String((e && (e.message || e.code)) || e || 'error')
const run = job => (queue = queue.then(job).catch(e => ({ shown: false, reason: errText(e) })))
const idle = () => queue.then(() => null)

// A tap on the countdown's buttons, for whoever runs the rest on screen (store/useUI.js).
let changeHandler = null
export function onRestChange(fn) { changeHandler = fn }

// One load, shared: two calls at once must not add the listener twice.
let loading = null
const load = () => {
  if (!loading) loading = (async () => {
    const [{ registerPlugin }, { LocalNotifications }] = await Promise.all([import('@capacitor/core'), import('@capacitor/local-notifications')])
    const RestTimer = registerPlugin('RestTimer')
    // Listening from the first call on is soon enough: the buttons exist only once a rest is
    // posted, and the plugin holds back a change that nobody is listening for yet.
    try { await RestTimer.addListener('restChange', change => changeHandler?.(change)) } catch { /* the buttons still move the phone's side */ }
    return { RestTimer, LocalNotifications }
  })().catch(e => { loading = null; throw e })
  return loading
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

// Resolves with the RestTimer plugin's answer, { shown, reason?, alertError? }; null where
// nothing ran (the switch off, not Android). `key` names the rest in what the buttons report.
export function showRest(S, { endsAt, text = '', key }) {
  if (!MOBILE || !S?.restNotify) return idle()
  return run(async () => {
    if (!(await isAndroid())) return null
    const { RestTimer } = await load()
    const r = await RestTimer.start({
      key, endsAt, title: t('Rest'), text, channelName: t('Rest timer'),
      alertTitle: t('Rest over — next set!'), alertText: text, alertChannelName: t('Rest over'),
      step: REST_STEP, lessLabel: t('−{0}s', REST_STEP), moreLabel: t('+{0}s', REST_STEP), skipLabel: t('Skip'),
    })
    return r || { shown: false, reason: 'no answer' }
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

// What Android has up (RestTimer.status): { enabled, channel, active, actions, promotable,
// promoted, canPromote, sdk, rest, alarm }; null off Android.
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
    await (await load()).RestTimer.stop({ keepAlert })
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
