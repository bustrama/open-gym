// Evaluates one JS expression in the app's WebView through the DevTools protocol (the debug
// build has WebView debugging on) and prints the result. Usage: node probe.mjs '<expr>'
// A few helpers are defined in the page first: __clickText, __rowSwitch, __rowClick, __state.
const expr = process.argv[2]
const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(p => p.type === 'page') || list[0]
if (!page) { console.log('no page', JSON.stringify(list)); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const send = (method, params) => new Promise(res => {
  const i = ++id
  const h = e => { const m = JSON.parse(e.data); if (m.id === i) { ws.removeEventListener('message', h); res(m) } }
  ws.addEventListener('message', h)
  ws.send(JSON.stringify({ id: i, method, params }))
})
const prelude = `
window.__clickText = txt => {
  const els = [...document.querySelectorAll('button, a, [role=button]')].filter(e => e.textContent.includes(txt))
  els.sort((a, b) => a.textContent.length - b.textContent.length)
  if (!els[0]) throw new Error('nothing to click with text: ' + txt)
  els[0].click(); return els[0].textContent.trim().slice(0, 80)
}
window.__row = txt => {
  const row = [...document.querySelectorAll('.lrow')].find(r => r.textContent.includes(txt))
  if (!row) throw new Error('no row with text: ' + txt)
  return row
}
window.__rowSwitch = txt => { const sw = window.__row(txt).querySelector('[role=switch]'); sw.click(); return 'clicked' }
window.__rowChecked = txt => window.__row(txt).querySelector('[role=switch]').getAttribute('aria-checked')
window.__rowClick = txt => { window.__row(txt).click(); return 'clicked' }
window.__state = () => JSON.parse(localStorage.getItem('gym_state_v1') || 'null')
// A workout under way (two exercises, three sets each), a 60-second rest and the rest
// notifications on. Nothing is stored yet right after onboarding (the store fills in the
// defaults on load); a weigh-in and _ts ahead keep the file mirror from winning on the reload.
window.__seedWorkout = () => {
  const S = window.__state() || {}
  const today = new Date().toISOString().slice(0, 10)
  S.bodyweight = [{ d: today, w: 80, t: Date.now() }]
  const e = id => ({ id, target: { sets: 3, reps: 8 }, sets: [0, 1, 2].map(() => ({ w: 60, r: 8, done: false })) })
  S.restNotify = true
  S.restSec = 60
  S.active = { id: 'smoke', d: today, start: Date.now(), routineId: null, name: 'Smoke', bw: null, cur: 0, entries: [e('0025'), e('0739')] }
  S._ts = Date.now() + 600000
  localStorage.setItem('gym_state_v1', JSON.stringify(S))
  setTimeout(() => location.reload(), 100)
  return 'seeded'
}
// Ticks the first set not yet done.
window.__tick = () => {
  const box = [...document.querySelectorAll('.chk')].find(b => b.getAttribute('aria-checked') !== 'true')
  if (!box) throw new Error('no set to tick')
  box.click(); return 'ticked'
}
// The rest bar as the user sees it.
window.__timer = () => { const t = document.querySelector('#timer .t'); return t ? t.textContent : 'no rest' }
// Records what the plugin reports from the countdown's buttons, next to the app's own listener.
window.__listen = async () => {
  window.__changes = window.__changes || []
  await Capacitor.registerPlugin('RestTimer').addListener('restChange', c => window.__changes.push({ ...c, at: Date.now() }))
  return 'listening'
}
`
await send('Runtime.evaluate', { expression: prelude })
const wrapped = `(async () => { try { return { ok: await (${expr}) } } catch (e) { return { error: String(e && (e.message || e)), code: e && e.code } } })()`
const r = await send('Runtime.evaluate', { expression: wrapped, awaitPromise: true, returnByValue: true })
console.log('>>', expr.slice(0, 120))
console.log(JSON.stringify(r.result?.result?.value ?? r, null, 2))
ws.close()
