# Patchwork MCP server (Claude Desktop path)

Contribute from **Claude Desktop** (which has no shell) via MCP. The server runs locally over
stdio and talks to the Patchwork platform's REST API. It exposes tools to claim work, stream
progress, and submit findings, plus a **`hunt` prompt** that drives the continuous
claim → work → submit → claim loop.

## Install

```bash
cd mcp && npm install
```

## Wire it into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```jsonc
{
  "mcpServers": {
    "patchwork": {
      "command": "node",
      "args": ["/Users/cor/Documents/projects/patchwork/mcp/server.mjs"],
      "env": {
        "PW_URL": "http://localhost:3040",   // your running platform (deployed URL for remote contributors)
        "PW_HANDLE": "cor",                   // auto-joins with the code to get a token…
        "PW_CODE": "patchwork",               // …or set PW_TOKEN instead (from the Join page)
        "PW_LOCATION": "London"
      }
    }
  }
}
```
Restart Claude Desktop. The `patchwork` tools and the **`hunt`** prompt appear.

## Test the continuous poll loop

In Claude Desktop, invoke the **`hunt`** prompt (or just say *"keep claiming and hunting Patchwork tasks until there are none"*). The model will:

1. `pw_next_task` → claim a work item (or stop on `{none:true}`)
2. `pw_trace` progress as it reasons (streams to the live board)
3. `pw_submit_finding` with a PoV (`claimed:"reproduced"` only with a real repro)
4. loop back to step 1

Watch the dashboard: your node pings in, traces stream, findings flip verifying → verified/rejected.

## Tools
- `pw_status` — swarm snapshot
- `pw_next_task` — claim the next work item (the poll)
- `pw_trace {kind,text}` — live progress line
- `pw_submit_finding {…, pov, patchDiff}` — submit for central verification
- `pw_heartbeat {status,currentWork}` — node status

## Local vs remote
- **Local test (now):** `PW_URL=http://localhost:3040`, platform running via `npm run dev`. The MCP
  server runs on your machine — nothing to deploy to test the loop from your own Desktop.
- **Remote contributors:** deploy the platform (Vercel) and set each contributor's `PW_URL` to the
  public URL. Each contributor still runs this stdio MCP server locally (their compute, their auth).

## Auth
Set either `PW_TOKEN` (grab it from the platform's Join page) or `PW_HANDLE` + `PW_CODE`
(the server auto-joins on first use). No API keys are shared — you contribute your own agent.
