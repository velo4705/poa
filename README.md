# POA — Port Anything

**POA is an MCP server that turns software binaries and source into ports for
other devices** — without losing more quality than the target physically allows.

Games, apps, firmware — from phones and PCs to TVs and unusual hardware.

> POA does not promise "no quality loss." It promises the *best achievable
> fidelity for the target*, with every degradation explicit and documented.

An MCP server, deliberately: an agent (OpenCode, Claude Code, any MCP client)
drives the pipeline; POA does the mechanical 60–90% and reports the rest.

## Status

M0 + M1 complete, M2 in progress, CI green:

- **M1**: Chocolate DOOM → aarch64 source port built via POA's own MCP tools,
  verified under qemu-user (`--version` passes, DEMO1 replay passed earlier).
- **M2**: 8 of 8 license-clean corpus projects all pass in CI on Linux
  (cross → windows-x86_64 PE via zig cc), Windows (native build + verify),
  and macOS (native Mach-O + verify). zstd · SQLite · libarchive · cmark ·
  Mbed TLS · cJSON · jansson · libzip.
- **M3+**: not implemented yet; POA's translation engine honestly reports
  itself as missing rather than guessing.

See `docs/ROADMAP.md` for the full milestone plan.

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

Wire into OpenCode — `opencode.example.json` in this repo is a working snippet
you can drop into your project or global config:

```sh
cp opencode.example.json opencode.json
# edit the absolute path to dist/server.js
```

OpenCode loads it as `mcp.poa`; tools show up as `poa.*` on the next session
start. See [docs/USAGE.md](docs/USAGE.md) for project-vs-global registration
and session lifecycle.

## Repository Layout

```
src/                    # TypeScript source for the MCP server
  targets.ts           # built-in + user-registered target profiles (zod-validated)
  manifest.ts          # ingestion: magic-byte classification → Port Manifest
  discrepancy.ts       # discrepancy mapper: required vs available, tagged by resolver
  buildsystem.ts       # source-tree build-system detection
  session.ts           # port sessions: .poa/port.json + append-only port-log.jsonl
  build.ts             # poa.build + poa.verify — CMake orchestration & verify harness
  report.ts            # PortReport type
  server.ts            # MCP stdio server wiring the tools together
shim/poa_shim.{c,h}    # C shim for the Win32↔POSIX gap, plus poa_shim_test.c
scripts/               # CI corpus drivers + utility scripts
  m1-doom.mjs          # M1 gate driver: DOOM → aarch64 via POA's own tools
  m1-sdl2.sh           # one-time static SDL2 build for zig cross toolchain
  m2-compat-*.mjs      # M2 corpus drivers (zstd, sqlite, libarchive, cmark, cjson, jansson, libzip)
  src/                 # (legacy, for the C shim scaffold)
  zig-cross/           # zig cc wrappers + cmake toolchain for Linux → Windows
  ci-patches/          # inline patches for upstream CMakeLists quirks
docs/                   # architecture, roadmap, usage, shim matrix, port reports
flake.nix              # dev shell: node, cmake, ninja, qemu-user, zig (binary-cached)
opencode.example.json  # working opencode.json snippet for wiring mcp.poa
LICENSE-MIT            # one half of the dual license
LICENSE-APACHE-2.0    # the other half — see package.json "license" / "files"
```

See `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/USAGE.md`.
