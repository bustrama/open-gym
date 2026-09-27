// Evaluates one JS expression in the app's WebView through the DevTools protocol (the debug
// build has WebView debugging on) and prints the result. Usage: node probe.mjs '<expr>'
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
const wrapped = `(async () => { try { return { ok: await (${expr}) } } catch (e) { return { error: String(e && (e.message || e)), code: e && e.code } } })()`
const r = await send('Runtime.evaluate', { expression: wrapped, awaitPromise: true, returnByValue: true })
console.log('>>', expr.slice(0, 120))
console.log(JSON.stringify(r.result?.result?.value ?? r, null, 2))
ws.close()
