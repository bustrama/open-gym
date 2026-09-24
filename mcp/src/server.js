/* The openGym MCP server itself: every tool registered on one McpServer. Built here rather than
   in an entry point so both transports — stdio (index.js) and HTTP (http.js) — serve the same
   tools with the same error shape, and a tool added here reaches both at once.

   The write tools exist only when a writer is passed (OPENGYM_MCP_WRITE, see writes.js): a
   read-only server does not even list them. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TOOLS } from './tools.js'
import { READ_TOOLS, writeTools } from './edit-tools.js'
import { routineTools } from './routine-tools.js'
import { workoutTools } from './workout-tools.js'
import { libraryTools } from './library-tools.js'

export const SERVER_INFO = { name: 'opengym', version: '0.2.0' }

export function createMcpServer({ writer = null } = {}) {
  const server = new McpServer(SERVER_INFO)
  const writes = writer
    ? [...writeTools(writer), ...routineTools(writer), ...workoutTools(writer), ...libraryTools(writer)]
    : []
  const tools = [...TOOLS, ...READ_TOOLS, ...writes]
  for (const t of tools) {
    server.tool(
      t.name,
      t.description,
      t.schema,
      async (params) => {
        try {
          const result = await t.handler(params || {})
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        } catch (err) {
          const code = err.code || 'ERROR'
          return {
            isError: true,
            content: [{ type: 'text', text: `${code}: ${err.message}` }]
          }
        }
      }
    )
  }
  return server
}
