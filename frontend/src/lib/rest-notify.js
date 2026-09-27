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
// posted must not leave an alert behind that was scheduled after the cancel.
let queue = Promise.resolve()
const run = job => (queue = queue.then(job).catch(() => {}))

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

export function showRest(S, { endsAt, text = '' }) {
  if (!MOBILE || !S?.restNotify) return queue
  return run(async () => {
    if (!(await isAndroid())) return
    const p = await load()
    await p.RestTimer.start({ endsAt, title: t('Rest'), text, channelName: t('Rest timer') })
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
  })
}

// keepAlert: the rest ran out while nobody was watching the app, so the alert at its end is the
// one thing that tells them. Everywhere else it goes too.
export function clearRest({ keepAlert = false } = {}) {
  if (!MOBILE) return queue
  return run(async () => {
    if (!(await isAndroid())) return
    const p = await load()
    await p.RestTimer.stop()
    if (!keepAlert) await p.LocalNotifications.cancel({ notifications: [{ id: REST_ALERT_ID }] })
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
