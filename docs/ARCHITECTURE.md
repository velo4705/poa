# POA Architecture

## Design Principles

1. **Three layers, one interface.** Ingestion → Translation → Adaptation. Every stage
   consumes a typed artifact from the stage before it and emits the next one.
2. **Adapters, not N×M.** Supporting a new target = one new adapter. Supporting a new
   input class = one new ingestor. Nothing else changes.
3. **Honesty over magic.** If a stage cannot do its job (e.g. lifting an obfuscated
   binary), it reports the blocker, the evidence, and the smallest human decision
   needed — it never silently emits garbage.
4. **Human-in-the-loop by default.** POA automates the 60–90% that is mechanical and
   escalates the rest with a concrete patch proposal.
5. **Explicit degradation.** Where fidelity must drop (frame rate, resolution, HDR,
   precision), the port declares it in a machine-readable `poa-report.json`.

## Layer 1 — Ingestion ("anything")

Classifies and normalizes the input:

| Class | Examples | Tools |
|---|---|---|
| `source` | git repo, source tarball | native compiler toolchains |
| `binary-native` | ELF / Mach-O / PE | Ghidra headless, Remill, RetDec, LLVM |
| `binary-managed` | .NET, JVM, WASM, Python | ildasm/ilspy, javap, wasmtime |
| `firmware` | raw flash dumps, images | binwalk, Ghidra, Qiling |
| `assets` | textures, audio, data | format-specific codecs |

Output: a **Port Manifest** — a JSON document describing input class, detected
platform, dependencies, required APIs, required hardware features, and confidence
scores per finding.

## Layer 2 — Core Translator (the abstract core)

Lowers the manifest's payload into a platform-free representation:

- **Source inputs** → cross-compile directly; POA orchestrates toolchains
  (CMake toolchain files, Nix, cross GCC/Clang).
- **Native binaries** → lift to LLVM IR (Remill/McSema class), then re-optimize for
  the target. Feasibility is scored per-binary; failure is a first-class outcome.
- **Managed/bytecode payloads** → strongest portability case: re-target the
  bytecode runtime or AOT-compile for the target.
- **WASM** → the most portable endpoint; used as the IR for the App/Embedded wedges
  when feasible.

The translator emits **Intermediate Port Artifacts (IPAs)**: IR + manifest +
dependency closure + a list of unresolved platform assumptions.

## Layer 3 — Target Adapters ("anywhere")

An adapter declares, for one target:

```text
[target.fridge-touchscreen-v1]
arch       = "aarch64"
os         = "linux-rt"
ram_mb     = 2048
gpu        = "none"          # adapter must supply software rasterizer or reject GPU apps
input      = ["touch"]       # mouse/keyboard → touch mapping policy
display    = "800x480"
formats    = ["wasm", "elf"]
```

Adapters are responsible for: syscall/API mapping, graphics API translation
(D3D9/11 → Vulkan → software), input remapping, filesystem/registry virtualization,
windowing/surface management, and packaging (APK, AppImage, WASM bundle, OTA image).

## The Four Stages of the Agent Loop

1. **Scout** — collect the target profile (from a file, a probing agent, or a
   database of known devices).
2. **Discrepancy Map** — structured diff: `required ∩ available`, `required − available`,
   `capability gaps` (e.g. "needs depth buffer, has none"), each tagged
   `auto-fixable | needs-adapter | needs-human`.
3. **Translate** — apply the discrepancy map:
   - auto → invoke toolchain/lifter;
   - needs-adapter → load or scaffold the adapter mapping;
   - needs-human → stop with a precise question and options.
4. **Verify** — build a test harness (emulator/container/device farm), run,
   capture crash dumps/logs, apply patches, loop until stable or budget exhausted.
   Every loop iteration is logged to the port report.

## Sub-ecosystems

- **POA-Games** — graphics API translation, input latency budget, frame pacing,
  controller→touch, save-format fidelity.
- **POA-Apps** — UI reflow (mouse→remote/touch), DPI scaling, accessibility tree,
  packaging for sandboxed stores.
- **POA-Embedded** — SRAM/flash budgeting, bare-metal vs RTOS vs Linux, peripheral
  shims (GPIO/I²C/SPI), unattended OTA updates.
- **POA-Assets** — texture/audio/font conversion, palette/depth reduction for weak
  displays, IP-safe reimplementation pipelines.

## What POA Deliberately Does Not Do

- Circumvent licensing, DRM, or anti-cheat.
- Claim parity for hardware the target lacks (no software GPU beating a real GPU).
- Silently degrade fidelity; all degradation is declared in the port report.
- Port to platform ecosystems that legally require vendor SDKs without one
  (console ports require platform-holder programs; POA can target devkits you have
  access to, nothing more).

## Verification Strategy

Every port ships with: `poa-report.json` (machine-readable), screenshots/recordings
where applicable, benchmark delta vs. baseline, and a reproducer (`poa verify`).
CI gates: build must succeed, harness must run ≥ N seconds without crash, no
undeclared degradation.
