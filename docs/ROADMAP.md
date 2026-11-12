# POA Milestone Roadmap

**Principle:** POA ships ports that *look the same from two sides* — behavioral
parity wherever the platform pair permits. Every milestone declares the fidelity
it commits to deliver:

| Tier | Meaning | Where it applies |
|---|---|---|
| `LOSSLESS` | Same behavior, verified by the project's own test suite | source + compatible platforms |
| `NEAR-LOSSLESS` | Behavior identical; perf/energy may differ | arch translation from source |
| `DEGRADED(<list>)` | Specific, machine-readable losses, in the port report | API shims, weak hardware |

Nothing in POA hides a fidelity drop. If a target can't be reached at the
committed tier, the milestone doesn't close — the port report says why.

Dates are targets, not promises. Update them honestly at every milestone gate.

---

## M0 — Foundation ✅ (landed Nov 2026)

TypeScript MCP server (`@modelcontextprotocol/sdk`), stdio, tool namespace `poa.*`.

- Tools: `poa.list_targets`, `poa.scout_target`, `poa.inspect_input`, `poa.plan_port`
- Byte-level ingestion (ELF/PE/Mach-O/WASM/ZIP/firmware), confidence scores, explicit unknowns
- Discrepancy mapper with `auto | needs-adapter | needs-human` tagging
- Port report v1; architecture + roadmap docs; stdio smoke test

**Gate passed:** smoke test green; honest blocker on translation engine.

## M1 — The First Real Port ✅ COMPLETE (Nov 12, 2026)

**Goal achieved:** `poa.plan_port` on Chocolate DOOM ends in a *running* ARM64
binary — built via POA's own MCP tools (dogfooded by `scripts/m1-doom.mjs`),
executed under qemu-user: `./chocolate-doom --version` → `Chocolate Doom 3.1.1`, exit 0.

**Evidence:** `docs/m1-port-report.json` — status `verified`, zero blockers,
artifacts: chocolate-doom/heretic/hexen/strife/setup/server/midiread/mus2mid,
all detected as aarch64 ELF.

**Committed tier: `NEAR-LOSSLESS`** — same source, same build system; note the
verification was a smoke run (`--version` under qemu, SDL dummy video), NOT a
gameplay soak test. Behavioral diff-testing is future work.

New capabilities (✅ landed, all dogfooded by the gate run):
- Session state: `poa.start_port` ✅, `poa.port_status` ✅, `poa.get_report` ✅
  (`.poa/port.json` + `.poa/port-log.jsonl`)
- Source analysis: `poa.detect_buildsystem` ✅
- `poa.add_target` ✅ — user-registered targets, zod-validated
- Build orchestration: ✅ `poa.build` (CMake; cross via **zig cc → aarch64-linux-musl static**
  when no system cross-gcc exists — nixpkgs `pkgsCross` builds 532 packages from source and was rejected;
  `POA_CMAKE_TOOLCHAIN_FILE` env override supported; `cmakeArgs` pass-through added after the gate exposed a missing `-DENABLE_SDL2_MIXER=OFF`)
- SDL2 (minimal, static) for the target built by `scripts/m1-sdl2.sh` — checksum-verified
- Verify harness v1: ✅ `poa.verify` (native or qemu-user; timeout = stayed-up)
- `flake.nix` dev shell: ✅ nodejs 24, cmake, ninja, qemu, zig — all binary-cached
- Human escalation: `poa.request_human` ✅, `poa.resolve_escalation` ✅;
  degradation declaration: `poa.declare_degradation` ✅
- Report bug found & fixed during the gate: `requireSession` treated `verified`
  sessions as nonexistent, breaking `poa.get_report` immediately after a passed verify.

**Reproduce:**
```sh
nix develop --command sh scripts/m1-sdl2.sh   # one-time: static aarch64 SDL2
nix develop --command node scripts/m1-doom.mjs # full gate: clone required at /tmp/opencode/chocolate-doom
```

**Committed tier:** `NEAR-LOSSLESS` (same code, same tests pass; perf native to ARM64)
**Gate:** one command line → DOOM boots on ARM64 via `poa.verify`; port report says `NEAR-LOSSLESS`
**Kill criteria for scope:** if DOOM needs GPU pathfinding we can't reach, drop to
Chocolate DOOM's SDL1 renderer or build server-mode first — don't rathole.

## M2 — Two Sides, Same Face: Linux ↔ Windows Parity (Mar – May 2027) 🏃 in progress

**Goal:** prove "exclusive port, converted, looks identical" for the case that
happens *today*: same-ISA C/C++ porting between Linux and Windows.

Landed (v0.3.0):
- `poa.choose_strategy` — evidence-driven decision ladder (source→native LOSSLESS,
  source+arch→cross NEAR-LOSSLESS, binary same-ISA→compat-shim DEGRADED,
  binary cross-ISA→lift-to-IR/DBT DEGRADED, WASM→runtime, iOS-policy→impossible)
- `poa.scan_dependencies` — ELF (readelf/DT_NEEDED), PE (objdump/DLL imports),
  WASM (import-section scan); Mach-O → honest unsupported, never faked
- `docs/SHIM.md` — POSIX↔Win32 compliance matrix, 18 mappings, fork() absence
  flagged as top failure mode; lossy mappings must be declared in the port report
- CI: Ubuntu + Windows + macOS build + stdio smoke (`.github/workflows/ci.yml`)

Still to do (M2 gate):
- POSIX↔Win32 shim implementation increments (items 1–15 of SHIM.md)
- Cross-build matrix in CI; ≥ 8 license-clean projects green on both OSes
- POSIX↔Win32 ABI shim surface, bounded and growing by demand:
  files/paths, sockets, threads, time, signals, console — with a compliance matrix
- `poa.scan_dependencies` — `DT_NEEDED`, PE import tables, WASM imports → closure diff
- Cross-build matrix in CI: {Linux, Windows} × {x86_64, aarch64}

**Committed tier:** `LOSSLESS` for CLI/server-class C/C++ projects whose own test
suites pass on both OSes (target: ≥ 8 license-clean projects from a public corpus,
e.g. coreutils-class utilities, vim/neovim, sqlite tools)
**Gate:** ≥ 8 projects green on both OSes from one manifest; failures reported, never silenced
**Out of scope at this tier:** DirectX, Win32 windowing edge cases, drivers, MSVC-only extensions

## M3 — The Binary Frontier Spike (Jun – Jul 2027)

**Goal:** decide with evidence whether static retranslation goes into the product.

- Static lift of 5 small, license-clean x86-64 ELFs via Remill/McSema and Ghidra headless
- Measure: lift rate, recompile success, test-suite pass rate, perf delta vs. QEMU
- ADR: adopt lifter **or** drop M5-binary scope to compat-shim only

**Committed tier:** `DEGRADED(perf, rare-instructions)` permitted, must be quantified
**Gate:** ADR merged with measured numbers; ≥ 3 of 5 binaries byte-verified for behavior

## M4 — WebAssembly: One Artifact, Every Target (Aug – Oct 2027)

**Goal:** the most portable endpoint — WASM as universal IR for Apps/Embedded.

- Source→WASM via clang/emscripten-class flow; WASM→native via wasmtime-class runtime
- Target adapters: `web-browser`, `linux-*-wasmtime`, `tv-smarttv-generic (WASM)`
- `poa.package` v1: WASM bundle + host shell

**Committed tier:** `NEAR-LOSSLESS` for compute; `DEGRADED(dom-ui)` for UI (reflow needed)
**Gate:** one non-trivial app (terminal emulator) live on ≥ 3 targets from one IPA
**Non-goal:** GPU-heavy or anti-cheat payloads

## M5 — POA-Apps: Refacing the UI (Nov 2027 – Feb 2028)

**Goal:** make ports *look native* — the "same from two sides" promise for eyes, not just syscalls.

- Adapter policy language: mouse→touch/d-pad/keyboard mapping, DPI/10-foot scaling
- Layout reflow heuristics + explicit per-app override file (never silent)
- Golden-image visual regression harness per target; `poa.declare_degradation`
  covers UI losses (e.g. "hover states removed")

**Committed tier:** `DEGRADED(input-latency, modality)` on TVs/fridges, quantified
**Gate:** one desktop app genuinely usable (not just running) on `tv-smarttv-generic`
with declared degradations and passing visual diffs

## M6 — POA-Games (Q1–Q2 2028)

**Goal:** DirectX 9/OpenGL → Vulkan path, frame pacing, controller→touch.

**Committed tier:** `DEGRADED(…)` per game, declared; perf within 20% of native baseline target
**Gate:** one licensed DX9 title playable on `linux-aarch64-generic`, FPS delta reported
**Hard boundary:** no anti-cheat bypass, no DRM removal, no console SDKs without access

## M7 — POA-Embedded: The Smart Fridge, For Real (2028, exploratory)

**Goal:** prove the three-layer stack on bare metal. Zephyr-class adapter;
strict SRAM/flash budgets; GPIO/I²C shims; LED-matrix demo as controlled showcase.

**Committed tier:** `DEGRADED(everywhere, by necessity)` — declared in bytes, not vibes
**Gate:** DOOM-class demo logic running on Cortex-M with < 256 KB SRAM, all losses in report

---

## Milestone gates, universally

Every milestone closes only when:

1. `npm run build` + typecheck + smoke test green in CI
2. The milestone's demo port runs under `poa.verify` (or a documented substitute)
3. Port report committed, status `verified`, degradations declared
4. This file updated: actual dates, what slipped, why

## The Fidelity Contract (product-wide)

- `LOSSLESS` or `NEAR-LOSSLESS` wherever source exists and platforms cooperate
- `DEGRADED(<list>)` everywhere else — itemized, quantified, in the report, forever
- Never: hidden loss, fake green checkmarks, "it mostly works"
- Delivery modes are labeled: `native-artifact` · `compat-runtime` · `source-derived` · `impossible-on-platform`
  (see `docs/ACCEPTANCE.md` for the end-to-end acceptance vision and its hard limits)
