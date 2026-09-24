// Shared by the write-path tests: the api's document store reduced to what the writer relies on
// (api/server.js conditionalWrite) — a revision that must match, a 409 carrying the current
// document, `active` stripped, `_rev` server-owned. `interleave` holds writes "a phone" makes
// between the writer's read and its write, one per attempt, to exercise the 409 retry.
import { z } from 'zod'
import { ConflictError } from '../src/api-client.js'
import { createJournal } from '../src/journal.js'
import { createWriter } from '../src/writer.js'

export const clone = o => JSON.parse(JSON.stringify(o))

export function fakeApi(initial) {
  const srv = { state: clone(initial), rev: 1, writes: 0, interleave: [] }
  const client = {
    async read() { return { state: srv.state ? clone(srv.state) : null, rev: srv.rev } },
    async write(state, baseRev) {
      const other = srv.interleave.shift()
      if (other) { other(srv.state); srv.rev += 1 }
      if (baseRev !== srv.rev) throw new ConflictError(clone(srv.state), srv.rev)
      const doc = clone(state)
      delete doc.active
      srv.rev += 1
      doc._rev = srv.rev
      srv.state = doc
      srv.writes += 1
      return { rev: srv.rev }
    }
  }
  return { srv, client }
}

// A writer over a fake api, and `call(name, params)` that parses the arguments against the
// tool's schema first — what the MCP SDK does before a handler ever runs.
export function harness(state, toolSets) {
  const { srv, client } = fakeApi(state)
  const writer = createWriter({ client, journal: createJournal({ dir: null }) })
  const all = toolSets.flatMap(f => (typeof f === 'function' ? f(writer) : f))
  const call = (name, params = {}) => {
    const t = all.find(x => x.name === name)
    if (!t) throw new Error(`no tool ${name}`)
    return t.handler(z.object(t.schema).parse(params))
  }
  return { srv, writer, call }
}
