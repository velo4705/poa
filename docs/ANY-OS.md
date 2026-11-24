# Any OS → Any OS in POA

"Port anything" means: given an input and a target OS/arch, POA produces a plan and, where the
mechanism exists, a verified artifact. It does **not** mean one magic button turns any Windows
binary into a working app on every platform.

## What it actually means, by input class

| Input | Same OS/arch | Different OS/arch |
|---|---|---|
| C/C++ source (CMake) | `poa.build native` → LOSSLESS | `poa.build cross` with toolchain → NEAR-LOSSLESS; `poa.verify` proves it |
| Go source | native build | `poa.lift`/`poa.recompile` for analysis only; real port = cross-build |
| Managed .NET source | build for host | `poa.convert_wpf_to_avalonia` → target-native UI toolkit + `poa.build` (DEGRADED until APIs are rewritten) |
| WASM | runtime | `web-browser`, `wasmtime` targets — the portable middle layer |
| Native binary, few imports | repackage | narrow `poa.lift` + `poa.recompile` + per-binary native shim (verified for a 3-import PE) |
| Native binary, many imports / GUI / drivers | repackage | no binary-only path: source recovery + adapters, declared DEGRADED |
| Firmware | repackage | cross-compile to target MCU; qemu/board smoke test |

## The tool that answers the question

`poa.port_matrix` ingests one input and runs the real strategy ladder + discrepancy mapper against
**every registered target**. Example (installer source):

```
linux-x86_64-generic → source-recompile    LOSSLESS
linux-aarch64-generic → cross-compile       NEAR-LOSSLESS
windows-x86_64-mingw → cross-compile       NEAR-LOSSLESS
macos-aarch64         → cross-compile       NEAR-LOSSLESS
tv-smarttv-generic    → cross-compile       NEAR-LOSSLESS
embedded-cortexm      → cross-compile       NEAR-LOSSLESS (3 adapter gaps)
web-browser           → cross-compile       NEAR-LOSSLESS (WASM adapter)
```

Each row lists gaps tagged `auto` / `needs-adapter` / `needs-human`. POA never marks a gap closed
without a runnable artifact: `poa.build` + `poa.verify` are the proof.

## Universal mechanism

1. **Source is the portable representation.** For every target, rebuild from source with the
   target toolchain (`poa.build`).
2. **Adapters close platform gaps.** UI toolkit (WPF→Avalonia/GTK), input (mouse→touch/d-pad),
   device APIs (registry→XDG, COM→D-Bus, WDF→uhid/PipeWire), packaging (desktop entry/APK).
   Declare each loss with `poa.declare_degradation`.
3. **Binary→binary is a narrow exception**, not the general rule: it works when the missing OS
   surface is a handful of functions (see `docs/PORTABILITY.md`). POA reports the boundary honestly.
4. **Never stop:** when a row is blocked, `poa.next_attempt` produces three genuinely different
   mechanisms to try next (see `docs/POA-MOTIVATION.md`).

## Adding a new OS target

`poa.add_target` registers a target profile (os, arch, binFormats, gpu/input/display capabilities).
It immediately appears in `poa.port_matrix`: POA computes the same plan for your fridge, TV or
mobile target as for Linux/Windows/macOS. The adapter implementation is the work the agent does
with POA's build/verify tools; the honest report is the output.
