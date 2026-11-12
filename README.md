# POA — Port Anything

**POA is an MCP server that turns software binaries and source into ports for
other devices** — without losing more quality than the target physically allows.

Games, apps, firmware — from phones and PCs to TVs and unusual hardware.

> POA does not promise "no quality loss." It promises the *best achievable
> fidelity for the target*, with every degradation explicit and documented.

An MCP server, deliberately: an agent (OpenCode, Claude Code, any MCP client)
drives the pipeline; POA does the mechanical 60–90% and reports the rest.

## Status

M0 — foundation. The pipeline stages are real, the translation engine is
not (see `docs/ARCHITECTURE.md`). Every tool tells the truth about that.

## How It Works — Three Layers

```
┌──────────────┐   ┌───────────────────┐   ┌──────────────────┐
│  INGESTION   │──▶│   CORE TRANSLATOR │──▶│ TARGET ADAPTERS  │
│  ("anything")│   │  (platform-free)  │   │   ("anywhere")   │
└──────────────┘   └───────────────────┘   └──────────────────┘
```

1. **Ingestion** — classify the input (source / binary / assets / firmware). ✅ real (`poa.inspect_input`)
2. **Core Translator** — lower to a portable representation (LLVM IR / WASM). ❌ not built yet
3. **Target Adapters** — one adapter per device; adding a target ≠ re-porting the app. ❌ not built yet

## The Agent Loop

POA exposes its first stages as MCP tools:

1. **Environment Scouting** — `poa.scout_target`: probe the target's limits
   (CPU, RAM, OS, GPU, peripherals).
2. **Discrepancy Mapping** — `poa.plan_port` (stages 1–3): diff what the input
   needs vs. what the target has; each gap tagged `auto | needs-adapter | needs-human`.
3. **Translation** — ❌ not implemented; reports itself as a blocker, honestly.
4. **Autonomous Debugging** — ❌ not implemented; will run a test harness per port.

## Tools

| Tool | Stage | What it does |
|---|---|---|
| `poa.list_targets` | — | Enumerate built-in target profiles |
| `poa.scout_target` | 1 | Full profile of one target |
| `poa.inspect_input` | ingest | Byte-level classification → Port Manifest (ELF/PE/Mach-O/WASM/ZIP/firmware) |
| `poa.plan_port` | 1–3 | Full plan + machine-readable port report JSON; optional `out` file |

## Legal & Ethical Scope

POA operates on software **you have the right to port**: your own code,
open-source software, or binaries you're licensed to modify or redistribute.
POA is not a circumvention tool. No DRM removal, no anti-cheat bypass.
Console targets require platform-holder SDK access.

## Quick Start

```sh
npm install
npm run build
node scripts/smoke.mjs   # end-to-end stdio test (initialize, tools/list, tools/call)
```

Wire into OpenCode (`opencode.json`):

```json
{
  "mcp": {
    "poa": {
      "type": "local",
      "command": ["node", "/path/to/poa/dist/server.js"]
    }
  }
}
```

## Repository Layout

```
src/targets.ts      # target device profiles (the "anywhere" side)
src/manifest.ts     # ingestion: magic-byte classification → Port Manifest
src/discrepancy.ts  # discrepancy mapper: required vs available, tagged by resolver
src/report.ts       # PortReport type — every run emits one, success or not
src/server.ts       # MCP stdio server wiring the tools together
scripts/smoke.mjs   # stdio smoke test
docs/               # architecture, design decisions
```

See `docs/ARCHITECTURE.md`.
