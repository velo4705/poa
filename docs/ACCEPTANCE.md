# POA Acceptance Vision — "Same As The Exclusive Variant"

**As stated by the founder (Nov 2026):**

> You provide a Windows binary and a Linux binary; POA ports them to their
> opposite. It should work the same as the exclusive variant. Not only
> binaries — architectures can be ported too. APKs from Android, or apps
> from iOS, can be ported as well.

This document records that vision and is blunt about which parts are
buildable, which parts are research, and which parts are impossible today —
because treating all three as equally deliverable would be lying with
software.

## The acceptance ladder (in order of feasibility)

### A1 — Windows x86-64 binary → Linux x86-64 (same ISA) ◆ realistic
Path: compatibility layer or static retranslation; Win32 → POSIX, SEH → DWARF
EH, CRT → glibc/musl semantics. Tools that already prove the pattern exist
(Wine/Proton). "Same as the exclusive variant" is approachable for
CLI/server-class software and Win32 GUI software of moderate complexity.
Degradation classes: raw DirectDraw/DX11 edge cases, drivers, anti-cheat,
DRM — all declared, never hidden.

### A2 — Linux x86-64 binary → Windows x86-64 (same ISA) ◆ realistic-ish
Path: no Wine equivalent exists on Windows (nothing reimplements ELF +
glibc syscall semantics on Windows out of the box). Options:
- Static retranslation (lift → IR → re-emit with a Linux-syscall shim) — M3-class effort
- Source recompile when available — easy, LOSSLESS tier
- WSL2/container-based packaging — not a port, it's a wrapper; POA may offer
  it as a delivery mode with the label clearly said out loud

### A3 — Cross-arch (Windows x86-64 → Linux ARM64) ◆ hard, honest degradation declared
Path: A1/A2 plus instruction-set translation. Static lift is research-grade;
DBT (qemu/box64-class) works but is a *runtime*, not a recompiled artifact.
The word "lossless" must not appear here.

### A4 — Android APK → Linux/desktop ◆ hard but real
Path: DEX → machine code (ART AOT or a clean-room runtime), Android framework
APIs → shim over POSIX (window, input, sensors, storage). Evidence this is
doable in principle: Waydroid (Linux containers), Anbox, Scrcpy — none are
ports, all are emulation/containers. A true recompiled "native" APK-class
port is a multi-year runtime project. Realistic POA deliverable: **APK in →
running in a Linux-side Android-compatible runtime, packaged by POA, with a
compatibility matrix** — clearly labeled as such.

### A5 — iOS app → anything ◆ policy-blocked, and POA cannot fix policy
- Apple forbids JIT compilation outside the WebKit engine on stock iOS.
- App Store review forbids downloading executable code; emulators/interpreters
  survive per-region and per-review-whim and are routinely rejected or removed.
- There is no legal ARM64 iPhone target that accepts foreign binaries.

POA can, at most: port iOS **source** to Android/other (Swift→Kotlin-class
rewrite tooling, M5+), or produce iOS-from-Android via source-level
cross-compile of shared logic. Binary-to-iOS is not achievable on-device,
no matter what the tool claims. POA will not pretend otherwise.

### A6 — APK → iOS ◆ combined worst case
A4 × A5. Out of scope unless platform policy changes. POA reports this as
`needs-human / cannot-ship`, not as a failure of ambition.

## The contract this creates for POA

1. **Every acceptance case ships with a compatibility matrix** — what works,
   what degrades, what's impossible. Machine-readable, in the port report.
2. **Delivery mode is labeled honestly**: `native-artifact` ·
   `compat-runtime` (e.g. Wine-class or Android-runtime shim) ·
   `source-derived` · `impossible-on-platform`.
3. **Acceptance tests must name the tier**: M2/M3/A1/A2 for binaries,
   A4-style for APKs — never an unqualified "ported".
4. **The founder's end-of-project test** is therefore restated as:
   - A1 and A2 on real binaries you own (target: runs, matrix committed)
   - A3 with quantified degradation (target: runs or documented why not)
   - A4 in "compat-runtime" mode (target: runs, labeled)
   - A5 explicitly demonstrated as `cannot-ship` with the policy evidence
   - The iOS side pursued only as **source-derived** porting

## What this does NOT change

M0–M1 continue unchanged. Acceptance cases are scheduled after M2/M3;
pulling them earlier would be optimism, not planning.
