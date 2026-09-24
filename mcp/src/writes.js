/* Whether this process may change the profile, and the writer it changes it through. Off unless
   OPENGYM_MCP_WRITE is set — and the api must agree independently (its own OPENGYM_MCP_WRITE,
   OPENGYM_MCP_API_TOKEN and OPENGYM_UID), so neither side alone can turn writes on.

   OPENGYM_MCP_API_TOKEN is this server's secret for the api's internal route. It is deliberately
   not OPENGYM_MCP_TOKEN: that one is handed to remote LLM clients so they can reach /mcp, and
   holding it must not be enough to write the profile around the MCP tools and their checks. */
import { createApiClient } from './api-client.js'
import { createJournal } from './journal.js'
import { createWriter } from './writer.js'

export const writesEnabled = () => /^(1|true|yes|on)$/i.test(process.env.OPENGYM_MCP_WRITE || '')

export function writerFromEnv() {
  if (!writesEnabled()) return null
  if (String(process.env.OPENGYM_MCP_API_TOKEN || '').length < 16) {
    throw new Error('OPENGYM_MCP_WRITE needs OPENGYM_MCP_API_TOKEN (16+ characters, the same value the api has)')
  }
  return createWriter({ client: createApiClient(), journal: createJournal() })
}
