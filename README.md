# POA — Port Anything

**POA is an MCP server that turns software binaries and source into ports for
other devices** — without losing more quality than the target physically allows.

Games, apps, firmware — from phones and PCs to TVs and unusual hardware.

> POA does not promise "no quality loss." It promises the *best achievable
> fidelity for the target*, with every degradation explicit and documented.

An MCP server, deliberately: an agent (OpenCode, Claude Code, any MCP client)
drives the pipeline; POA does the mechanical 60–90% and reports the rest.

## Status

M0 + M1 complete: POA ports source trees to other platforms end-to-end
(Chocolate DOOM → aarch64 via POA's own MCP tools, verified by DEMO1 replay).
M2 — Linux ↔ Windows parity — is mostly there: 5 of 8 corpus projects
build and verify natively on Linux, macOS and Windows (zstd, SQLite,
libarchive, cmark, Mbed TLS). See `docs/ROADMAP.md` for the gate criteria.

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

Sub-ecosystems: **POA-Games** · **POA-Apps** · **POA-Embedded** · **POA-Assets**.

## The Agent Loop

POA exposes its four stages as MCP tools:

1. **Environment Scouting** — `poa.scout_target`: probe the target's limits
   (CPU, RAM, OS, GPU, peripherals).
2. **Discrepancy Mapping** — `poa.plan_port` (stages 1–3): diff what the input
   needs vs. what the target has; each gap tagged `auto | needs-adapter | needs-human`.
3. **Translation** — ❌ not implemented; reports itself as a blocker, honestly.
4. **Autonomous Debugging** — ❌ not implemented; will run a test harness per port.

## Tools

| Tool | Stage | What it does |
|---|---|---|
| `poa.list_targets` | — | Built-in + user-registered target profiles |
| `poa.scout_target` | 1 | Full profile of one target |
| `poa.inspect_input` | ingest | Byte-level classification → Port Manifest (ELF/PE/Mach-O/WASM/ZIP/firmware/source trees) |
| `poa.detect_buildsystem` | 1 | Build-system candidates with confidence + cross-compile strategy |
| `poa.add_target` | — | Register a custom target (your fridge here), zod-validated |
| `poa.start_port` / `poa.port_status` | session | Open/track a port in `.poa/` (CWD-scoped, git-ignored inputs stay yours) |
| `poa.get_report` / `poa.declare_degradation` | session | Machine-readable port report; declared (never hidden) losses |
| `poa.request_human` / `poa.resolve_escalation` | escalation | Structured one-question escalations with options |
| `poa.build` | 3 | CMake-driven native/cross build (fixed argv, no arbitrary shells); emits artifact archs |
| `poa.verify` | 4 | Native or qemu-user run; records pass/fail/timeout into the report |
| `poa.plan_port` | 1–3 | Full plan + port report JSON |
| `poa.choose_strategy` | 2 | Evidence-driven decision ladder with fidelity tiers (LOSSLESS / NEAR-LOSSLESS / DEGRADED) |
| `poa.scan_dependencies` | ingest | ELF (readelf) · PE (objdump) · WASM (import-section scan) — Mach-O reports unsupported honestly |
| `poa.sessions` / `poa.session_switch` | session | Cross-project registry: list and switch between ports mid-session |
| `poa.finish_port` | session | Close verified ("keep") or abandon — refuses to call unverified work done |

## Legal & Ethical Scope

POA operates on software **you have the right to port**: your own code,
open-source software, or binaries you're licensed to modify or redistribute.
POA is not a circumvention tool. No DRM removal, no anti-cheat bypass.
Console targets require platform-holder SDK access.

## Usage

Short version: the agent drives POA; the state lives in the project root's
`.poa/`; the input can live anywhere. Full walkthrough — new session, existing
session, multi-project, concurrency — in **`docs/USAGE.md`**.

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
      "command": ["node", "/absolute/path/to/dist/server.js"]
    }
  }
}
```

For OpenCode the `opencode.json` path is resolved relative to the project's
directory — see [docs/USAGE.md](docs/USAGE.md) for the OpenCode-specific
snippet and project-vs-global registration.

## Repository Layout

```
src/targets.ts      # target profiles: built-ins + zod-validated user targets (.poa/targets/)
src/manifest.ts     # ingestion: magic-byte classification → Port Manifest
src/discrepancy.ts  # discrepancy mapper: required vs available, tagged by resolver
src/buildsystem.ts  # source-tree build-system detection (CMake/Meson/Cargo/…)
src/session.ts      # port sessions: .poa/port.json + append-only port-log.jsonl
src/build.ts        # poa.build + poa.verify — CMake orchestration & qemu/native harness
src/report.ts       # PortReport type — every run emits one, success or not
src/server.ts       # MCP stdio server wiring the tools together
shim/poa_shim.*     # C shim for the Win32↔POSIX gap (poa_strerror not built yet)
scripts/smoke.mjs   # full stdio smoke test (session lifecycle included)
scripts/m1-doom.mjs # M1 gate driver: DOOM → aarch64 via POA's own tools
scripts/m1-sdl2.sh  # one-time static SDL2 build for zig cross toolchain
scripts/zig-cross/  # zig cc wrappers + cmake toolchain for aarch64-linux-musl
docs/               # architecture, milestone roadmap, M1 port report, acceptance vision
flake.nix           # dev shell: node, cmake, ninja, qemu-user, zig (all binary-cached)
LICENSE-MIT         # one half of the dual license
LICENSE-APACHE-2.0  # the other half — see package.json "license" field
```

See `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/USAGE.md`.
