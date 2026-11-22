# Using POA — Sessions, Directories, and Where Things Live

POA is an MCP server: **your agent drives it**. There is no separate POA UI —
you tell the agent what to port, it calls the `poa.*` tools, you steer.

## Setup (once per machine)

Register the server in your MCP client. OpenCode example (`opencode.json`):

```json
{
  "mcp": {
    "poa": { "type": "local", "command": ["node", "/path/to/poa/dist/server.js"] }
  }
}
```

Launch-time project root, in order of precedence:

1. `--project /path/to/project` appended to the command
2. `POA_PROJECT_ROOT=/path/to/project`
3. whatever directory the client launched the server from (usually the open project)

## Binary inputs: the honesty ladder

Before attempting to port a binary, call `poa.assess_portability` (see
[PORTABILITY.md](PORTABILITY.md)). It walks the input from possible to impossible —
same-platform → pinned source → IR/object → freestanding → OS ABI → runtime coupling —
and returns a machine-readable refusal of "magic lifts" with the exact rung where the
road stops. Drive it from the CLI with `node scripts/assess.mjs <binary>`.

For managed .NET inputs, `poa.extract_dotnet` recovers C# source from IL and emits a
Windows→Linux dependency map (P/Invoke calls, UI framework, platform services). It is
the first step of a source-to-source port, never a complete port by itself.

## A new session, step by step

```text
You:    port ~/src/doom to linux-aarch64 and prove it runs
Agent:  poa.start_port { source: "/home/me/src/doom",
                         target: "linux-aarch64-generic",
                         provenance: "open-source", strategy: "cross-compile" }
        → creates  <cwd>/.poa/port.json   (the session)
                   <cwd>/.poa/port-log.jsonl  (append-only history)
                   registers the port in ~/.config/poa/sessions.json
Agent:  poa.choose_strategy … poa.detect_buildsystem …
Agent:  poa.build { mode: "cross" }          # artifacts in .poa/build/<session-id>/
Agent:  poa.verify { args: ["--version"], env: { "SDL_VIDEODRIVER": "dummy" } }
        → 'passed' → session becomes "verified"
Agent:  poa.finish_port { decision: "keep", note: "0.0.9 built + smoke-tested" }
```

Key point: **the input can live anywhere** (`/opt/games/x.exe`, `~`, a USB
mount). POA only writes state into the project root — never next to your input.

## An existing session (same project, days later)

Open the project, ask "where's the port?" — the agent calls `poa.port_status`,
which re-ingests the source and re-maps discrepancies against the target, and
tells you: session id, strategy, remaining gaps, declared degradations, open
escalations, last verification. If the project moved, POA doesn't pretend —
`poa.sessions` marks it `missing`.

## Multiple ports / multiple projects

| Tool | What it does |
|---|---|
| `poa.sessions` | list every project POA knows, with live-re-read status; current one flagged |
| `poa.session_switch` | re-point this MCP process at another project directory for all following calls |
| `poa.finish_port` | close `verified` as kept, or retire as abandoned — with a note in the log |

Switches are per-process; nothing is rewritten until you build/verify/finish.

## Concurrency

Mutating tools (`start_port`, `build`, `verify`, `declare_degradation`,
`request_human`, `resolve_escalation`, `finish_port`) hold a lock in
`.poa/port.lock`. A live lock fails fast with the holder's pid and since when.
A lock orphaned by a crashed agent clears automatically after 15 minutes.

## Where files land

| Path | Contents |
|---|---|
| `<project>/.poa/port.json` | the session (source of truth) |
| `<project>/.poa/port-log.jsonl` | append-only event log |
| `<project>/.poa/report.json` | last generated port report |
| `<project>/.poa/build/<id>/` | cross-built artifacts |
| `<project>/.poa/targets/*.json` | custom targets registered via `poa.add_target` |
| `~/.config/poa/sessions.json` | cross-project index (POA_HOME, or $POA_HOME) |
| `~/.config/poa/` | set `POA_HOME` to relocate the registry |
