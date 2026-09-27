// How far one tap moves a rest: the −/+ buttons of the rest bar (components/RestTimer.jsx) and
// of the phone's countdown notification (lib/rest-notify.js).
export const REST_STEP = 15

// What a button on the phone's countdown notification makes of the rest on screen. The phone
// moves its countdown and alert by itself, with the app in the background or not running at all
// (RestTimer.java), and reports the change when the app is up: { key, endsAt } after −15s or
// +15s, { key, skipped: true } after Skip. `key` is the one the rest was started with.
// Answers the rest timer to show, null when the rest is to end (skipped), or undefined when the
// change is not about this rest (the app has started another since, or has none) or changes
// nothing. A new end that has already passed (the app heard late) gives left 0: the timer's tick
// then ends the rest as it would any other.
export function restAfterPhone(timer, change, now) {
  if (!timer?.key || !change || change.key !== timer.key) return undefined
  if (change.skipped) return null
  const endsAt = Number(change.endsAt)
  if (!Number.isFinite(endsAt) || endsAt === timer.endsAt) return undefined
  const left = Math.max(0, Math.round((endsAt - now) / 1000))
  // The bar is left / total: the total moves with the end, and never drops under what is left.
  const total = Math.max(1, left, timer.total + Math.round((endsAt - timer.endsAt) / 1000))
  return { ...timer, endsAt, left, total }
}
