# Portability ladder: from possible to impossible

`poa.assess_portability` is the machine-readable enforcement of the README promise:

> ❌ Lift a binary to a different platform by magic — POA refuses to pretend

It takes one binary and a target (`targetOs`, `targetArch`), measures what it can, and walks an
ordered ladder. Every rung says what POA can honestly build there, with evidence. Refusal of
magic is unconditional and machine-readable: `verdict.magicLift === "refused"`.

```sh
node scripts/assess.mjs ./binary_test/gitlimp.exe
POA_TARGET_OS=firmware POA_TARGET_ARCH=aarch64 node scripts/assess.mjs ./firmware.bin
```

## The ladder

| # | Rung | Status | What it really means |
|---|---|---|---|
| 1 | same-platform | `possible` | Artifact is already for the target — repackage; LOSSLESS. |
| 2 | source-derived | `possible` / `conditional` | Go buildinfo → exact module + deps → rebuild (NEAR-LOSSLESS); other binaries need rights-holder source. |
| 3 | IR/object | `partial` | Remill lifts to bitcode, `poa.recompile` emits a relocatable object — an ANALYSIS artifact, never a runnable port. |
| 4 | freestanding | `possible` (firmware target) / `partial` (OS target) | No OS imports: real port possible for bare metal with startup code; for an OS target it is an unverified candidate. |
| 5 | OS ABI boundary | `blocked` | OS imports (DLL names / DT_NEEDED) require a shim for the source OS ABI. POA does not ship one. |
| 6 | runtime coupling | `impossible` | WPF, WebView2, WinForms, WDF drivers: no Linux equivalent at any binary level. Source rewrite only. |

Statuses: `possible` → `partial` → `conditional` → `blocked` → `impossible` → `not-applicable`.
The verdict reports `stopAtRung` (the first decisive rung), `bestHonestOutcome`,
`canProduceRunnablePort`, blockers, and a recommended tool chain. `canProduceRunnablePort`
is true only for same-platform artifacts, pinned-source rebuilds, and firmware targets with
correct startup — never for a lifted GUI binary.

## Verified walk-through (the four shapes of input)

| Input | Result |
|---|---|
| `/bin/ls` → linux/x86_64 | rung 1 `possible` — artifact IS the port; chain: inspect → scan → verify. |
| statically linked, no-import ELF → firmware/aarch64 | rung 4 `possible` — lift + recompile + startup + smoke run. |
| statically linked, no-import ELF → windows/aarch64 | rung 4 `partial` — candidate object only; runnable status UNVERIFIED until `poa.verify`. |
| `gitlimp.exe` → linux/x86_64 | rung 2 `possible` — Go buildinfo (19 deps) → source rebuild; rungs 5/6 block a binary lift (kernel32 + WebView2 COM). |
| `iProV410Win_Web.exe` (installer) → linux/x86_64 | rung 5 `blocked` — 16 OS imports; inner MSI payload needs separate assessment (WPF app → rung 6 `impossible`). |

## What the tool measures

- `ingest()` — format, arch, managed/native, platform hint (no magic guesses).
- `scanDependencies()` — real import lists (PE DLL names, ELF DT_NEEDED, WASM imports).
- `goBuildInfo()` — Go toolchain, module path, dependency graph and h1 hashes.
- Remill availability and supported arch for the IR rung.
- Runtime markers (WPF / WebView2 / WinForms / WDF / MSI) scanned from raw bytes.

A missing tool is reported as a blocker, never as a inferred dependency list. The `.sys`
driver marker was removed after testing because the substring matches "system32"; only
specific markers survive. Assess the **payload** of an installer separately from its stub.

## What it does not do

- Does not execute the binary.
- Does not decompile, emulate, or wrap with Wine.
- Does not claim a runnable port from a lifted Windows GUI; `verdict` says so explicitly.
- Does not include a Win32→POSIX ABI shim. Rung 5 stays blocked until one exists.
