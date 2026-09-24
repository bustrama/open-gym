/* The MCP's line to the api, for writes: the internal routes in api/server.js
   (/internal/mcp/state), reached over the compose network. The api stays the only writer of the
   profile document, and the MCP is a client of it the way a phone is — it reads a revision,
   changes the document, and writes it back only if nobody else wrote in between. */

// A write that lost the race: someone (a phone, a browser) wrote after we read. Carries the
// document as it is now, which the api sends back with its 409, so the change can be re-applied
// on top of it without a second read.
export class ConflictError extends Error {
  constructor(state, rev) {
    super('conflict')
    this.state = state
    this.rev = rev
  }
}

function apiError(status, data) {
  const why = status === 404
    ? 'writes are not enabled on the api — it needs OPENGYM_MCP_WRITE=1, OPENGYM_MCP_API_TOKEN and OPENGYM_UID'
    : status === 401 ? 'the api refused OPENGYM_MCP_API_TOKEN — it must be the same on both'
      : status === 403 ? 'the profile is disabled or does not exist'
        : `the api answered ${status}${data && data.error ? ': ' + data.error : ''}`
  const e = new Error(why)
  e.code = 'EAPI'
  return e
}

export function createApiClient({
  base = process.env.OPENGYM_API_URL || 'http://api:3000',
  token = process.env.OPENGYM_MCP_API_TOKEN,
  fetchImpl = fetch,
  timeoutMs = 15000
} = {}) {
  const url = base.replace(/\/+$/, '') + '/internal/mcp/state'
  async function call(method, body) {
    let r
    try {
      r = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (err) {
      const e = new Error(`the api is unreachable at ${base} (${err.message})`)
      e.code = 'EAPI'
      throw e
    }
    let data = null
    try { data = await r.json() } catch { /* an empty or non-JSON body is reported by status */ }
    return { status: r.status, data }
  }
  return {
    async read() {
      const { status, data } = await call('GET')
      if (status !== 200) throw apiError(status, data)
      return { state: data.state, rev: data.rev || 0 }
    },
    // `op` names the tool, for the api's audit log. Never anything from the document.
    async write(state, baseRev, op) {
      const { status, data } = await call('PUT', { state, baseRev, op })
      if (status === 409) throw new ConflictError(data && data.state, data && data.rev)
      if (status !== 200) throw apiError(status, data)
      return { rev: data.rev }
    }
  }
}
