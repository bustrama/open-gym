# openGym MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) bridge that lets an external LLM
application (Claude Desktop, Cursor, Cline, Continue, etc.) read your openGym profile —
routines, workouts, body-weight log, estimated 1RMs, and muscle balance — directly from your
self-hosted `./data` directory.

It is read-only, runs locally as a stdio process spawned by the LLM client, adds no new
container, and requires no extra authentication. The LLM never sees passkeys, VAPID keys, or
session secrets — it can only read the same `state-<uid>.json` files the openGym api already
writes. (A client on another machine can use the opt-in HTTP transport instead — see
[Remote clients](#remote-clients-the-http-transport).)

The numbers it answers with are computed by the **same pure functions the React UI uses**
(`frontend/src/lib/*.js`) — `estimate1RM`, `loadOfWorkouts`, `effectiveRoutine`, etc. — so a
"what's my bench 1RM?" answer matches the Stats screen exactly.

> Read-only by default. With `OPENGYM_MCP_WRITE=1` on both the MCP server and the api it can
> also change the profile — plan routines, schedule the week, log workouts and weigh-ins — every
> change undoable. See [Writing](#writing-opengym_mcp_write) below.

## Quick start

### 1. Install

```bash
cd mcp
npm install
```

### 2. Point it at your data

The MCP server reads the same `./data` directory `docker compose up` creates. Pick the profile
to answer for — its user id is in `./data/db.json` under `users[].id`:

```bash
# single-user instance (the common self-hosted case) — auto-detected:
node src/index.js

# multi-user instance, or just to be explicit:
OPENGYM_UID=<your-uid> OPENGYM_DATA=/path/to/openGym/data node src/index.js
```

### 3. Register with your LLM client

Add the server to your LLM client's MCP config. For Claude Desktop, edit
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "opengym": {
      "command": "node",
      "args": ["/absolute/path/to/openGym/mcp/src/index.js"],
      "env": {
        "OPENGYM_DATA": "/absolute/path/to/openGym/data",
        "OPENGYM_UID": "<your-uid>"   // optional — auto-detected if you have one profile
      }
    }
  }
}
```

For Cursor and other MCP-compatible clients, see the client's MCP docs — the same `command` +
`args` + `env` shape is what every stdio MCP server expects.

Restart the client; you should see the openGym tools appear with "serving profile \<name\>" on
the server's stderr.

### Remote clients: the HTTP transport

stdio needs the LLM client on the machine that holds `./data`. For a client anywhere else — an
agent on another box, a hosted assistant — `src/http.js` serves the same tools over the MCP
**Streamable HTTP** transport at `POST /mcp`: stateless, read-only, plain JSON answers (no SSE
stream for a proxy to buffer), and no new dependency — the transport ships in the MCP SDK
installed above.

It refuses to start without `OPENGYM_MCP_TOKEN`, or without `OPENGYM_UID` — a remote client is
answered for one named profile, never for whichever state file happens to exist — and every
request must send `Authorization: Bearer <that token>`. That is the floor, not the whole fence: put the path
behind an auth proxy as well. With Cloudflare:

1. **Run it.** In `.env`, set `OPENGYM_MCP_TOKEN` (e.g. `openssl rand -hex 32`), `OPENGYM_UID`
   and `COMPOSE_FILE=docker-compose.yml:docker-compose.mcp.yml`, then `docker compose up -d`. Its
   header has the one-time dependency install. The web container now carries
   `https://gym.example.com/mcp` to the `mcp` service, so the tunnel route you already have
   needs nothing new.
2. **Access:** a self-hosted application on `gym.example.com` with the path `mcp`, whose only
   policy is **Service Auth** → your service token. It is more specific than the app's own
   Access application, so it wins for that path. No identity-provider login — the client is a
   program.

(A proxy that would rather give it a hostname of its own can route straight to the container:
`MCP_BIND=0.0.0.0` publishes its port, `MCP_PORT` (8765), on every interface. Otherwise it stays
on loopback — a published port skips the host firewall.)

The client then sends three headers:

```jsonc
{
  "mcpServers": {
    "opengym": {
      "type": "http",
      "url": "https://gym.example.com/mcp",
      "headers": {
        "CF-Access-Client-Id": "<service token client id>",
        "CF-Access-Client-Secret": "<service token client secret>",
        "Authorization": "Bearer <OPENGYM_MCP_TOKEN>"
      }
    }
  }
}
```

`GET /healthz` answers `{"ok":true}` without a token, for the container healthcheck, and says
nothing else.

## Tools

Nine read-only tools in v1:

| Tool | What it answers |
|---|---|
| `list_routines` | What routines are saved in my profile? (names + exercise counts) |
| `get_routine` | What does the Push Day routine prescribe? (sets/reps/weight and rest per exercise) |
| `preview_session` | What will the app actually put on screen when I start this routine — after the progression policy and my history have overridden the plan? |
| `get_week_plan` | What's on my plan this week, including today with any date-specific override? |
| `list_workouts` | Recent sessions — newest first, with dates, sets done/planned, volume, duration, PRs, and the session note. |
| `get_workout` | Full set-by-set breakdown of one session, by `workout_id` or by date, with the session note and each exercise's notes (this session's, whether it was pinned for next time, and its standing note), and a shared `superset_group` on exercises done as a superset. On a day with two sessions the date alone returns both ids to pick from rather than guessing at one. |
| `get_bodyweight` | Weigh-ins with the latest weight, the goal line, and deltas vs goal. |
| `estimate_1rm` | All-time best 1RM for an exercise + the trend, or a PR table across all exercises. |
| `muscle_balance` | Which muscles I've trained this week/month/all-time, ranked + which I've neglected. |

`get_routine` and `preview_session` answer two different questions, and confusing them is the
easiest way for a coach to give wrong advice. `get_routine` reports what the routine *stores*.
`preview_session` reports what the athlete will actually *see*: a routine holding "squat 3×8 @
60 kg" opens at 75 kg if the policy deloaded from the last logged session, and the rep counts
come from history, not the plan. The routine's own numbers are the last fallback the session
builder consults, not the first. Ask `preview_session` before naming a weight.

Each tool returns JSON the LLM can format as it likes; structured fields (sets, dates, levels)
are pre-formatted into human-readable labels in `src/labels.js` so the LLM doesn't need to
re-interpret them.

Two more reads are always on: `search_exercises` (the library plus the athlete's custom
exercises, with the ids a routine needs) and `get_settings`.

### Writing (`OPENGYM_MCP_WRITE`)

Off unless `OPENGYM_MCP_WRITE=1` is set for the MCP server **and** the api — each side checks it
on its own, with the same `OPENGYM_MCP_API_TOKEN` and `OPENGYM_UID`. `OPENGYM_MCP_API_TOKEN` is a
second secret, for the api's internal route alone: remote clients hold `OPENGYM_MCP_TOKEN`, and
that must never be enough to write the profile around the tools and their checks. The internal
route also refuses anything that came through the web container, and any path that only parses
to it. The MCP server never writes a
file: it changes the profile through the api's internal routes (`/internal/mcp/state`, reachable
only on the compose network), with the same revision check a phone uses, so an edit made on a
phone in between is merged rather than overwritten. What it does is the app's own code wherever
the app has it — the routine editor's save rules (`lib/ex-config.js`), the Finish button
(`finishSession` in `lib/finish-workout.js`), the delete cascades.

| Tool | What it changes |
|---|---|
| `create_routine` / `update_routine` / `delete_routine` / `reorder_routines` | Routines and their exercises — the fields `get_routine` returns, so a routine can be read, edited and written back |
| `set_week_plan` / `set_day_override` | The weekly plan, and what is trained on one date |
| `log_workout` / `delete_workout` | A session that was done (PRs, working weights and filing as finishing it in the app), or its removal; logging again with `on_same_day: "replace"` edits one |
| `log_bodyweight` / `delete_bodyweight` / `set_goal_weight` | Weigh-ins and the goal line |
| `upsert_custom_exercise` / `delete_custom_exercise` | The athlete's own exercises |
| `set_exercise_note` / `set_favourite` / `set_bar_weight` | Standing notes, favourites, bar weights |
| `update_settings` | Rest timer, sounds, language, theme, workout layout, effort scale, reminder. Not kg/lb — that converts every stored weight, and stays in the app. |
| `list_recent_changes` / `undo_last_change` | The change history, and taking one back |

Every change is journaled as keyed patches (`OPENGYM_MCP_JOURNAL`, `./mcp-journal` in the
compose file). Undo restores only what that change touched, and refuses — unless forced — where
the athlete has changed the same thing since, so undoing an agent's edit never takes back a
workout logged on the phone after it. Each write is recorded in the api's activity log as
`admin.mcp.write`, by tool name, never with the document.

## How it reuses the training logic

The MCP server imports the training helpers under `frontend/src/lib/` directly as Node ESM
and calls the same functions the React UI does (`history.js`, `onerm.js`, `muscles.js`,
`exercises.js`). The numbers it returns match what the Stats screen shows, because they are
the same code.

The one lib file that wasn't Node-safe was `i18n.js` (Vite's `import.meta.glob` at module
top level) — split into `i18n-core.js` (pure, Node-safe) + `i18n.js` (Vite/React bits,
re-exports from core). `exercises.js` got a one-line `import.meta.env || {}` guard. No new
dependencies landed in `frontend/`, no public exports changed.

## Design constraints honoured

- **One runtime dependency beyond the MCP SDK:** none. No database driver, no HTTP framework.
- **No new container.** stdio transport is spawned by the LLM client; nothing to add to
  `docker-compose.yml`. The HTTP transport's container is opt-in, in its own
  `docker-compose.mcp.yml`.
- **No new auth.** The filesystem is the boundary — same as `docker compose` running on the
  user's box. No passkey material, VAPID keys, or session secrets ever cross it. The HTTP
  transport adds one bearer token of its own, and nothing else.
- **No telemetry, no network.** Reads `./data/*.json` and exits when the LLM client
  disconnects.

## Tests

```bash
cd mcp && npm test
```

79 cases seeding state from `frontend/src/lib/demoSeed.js` (the same deterministic fixture
the public demo runs on) — 58 for the tools, 20 for the HTTP transport's auth, limits and wire
format, and one stdio handshake end to end. Pins JSON shape and the user-facing edge cases: rest-day override,
missing routine, zero-workout history, no synced state, superset links, three 1RM formulas.
"Today" is pinned via `vi.useFakeTimers({ now: ..., toFake: ['Date'] })` so date-dependent
tools see consistent values regardless of when the suite runs. The pure lib functions have
their own 92 tests in `frontend/src/lib/*.test.js`.

## Roadmap

- **Done (Phase 1):** read-only stdio, 8 tools, direct `./data` access.
- **Done (Phase 1.5):** `preview_session` — the policy's next prescription, the opening set
  rows it produces, and which of plan / confirmed weight / history each number came from.
- **Done (Phase 2):** writes, opt-in (`OPENGYM_MCP_WRITE`). Instead of a token file and a write
  lock, the MCP server writes through the api — the one writer of `state-<uid>.json` — using
  the same conditional write as a device, so the revision check is the lock.
- **Done (Phase 3):** Streamable HTTP transport (`src/http.js`), opt-in container in
  `docker-compose.mcp.yml`. Same tool registration as stdio (`src/server.js`), second transport.

## License

AGPL-3.0-or-later, same as openGym.
