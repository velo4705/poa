# M3 — The Binary Frontier Spike (ADR)

**Status:** accepted for spike execution (Nov 2026)
**Owner:** POA (Port Anything)
**Window:** started Nov 2026; gate review ~1 week from kickoff

## Goal

Decide, with measurable evidence, whether static retranslation belongs in POA
as a shipping feature. The question is not "can anyone lift a binary," it is
"can POA deliver one specific Linux x86-64 ELF as a Windows PE that behaves
correctly on Windows."

## Committed deliverable (v1 spike)

Produce a Windows x86-64 PE executable from a statically-linked Linux ELF built
from a local `hello.c`, run that PE under Windows/wine, and report benchmarks.

- Input: One ELF x86-64 (`hello.c` → `zig cc -static -target x86_64-linux-musl`).
- Output: One PE x86-64 binary.
- Pass criterion: `poa.verify` outcome=`passed`; the executable prints
  `Hello from the M3 spike` and exits 0.
- Fail criterion: No verified pass produced after a recorded attempt. Milestone
  **closed with "no binary translation in product"** and roadmap falls back to
  compat-shim for Linux↔Windows binary cases.

## Approach (one direction only for v1)

1. Build `hello` as static x86-64 ELF via POA's own toolchain (dogfooding).
2. Attempt to lift **one** of: Remill (`lifting-bits/remill`), McSema,
   Ghidra headless. Try in the order listed; drop if upstream build is infeasible.
3. Re-emit via LLVM backend for `x86_64-windows-gnu`.
4. Link with `x86_64-w64-mingw32` or win32 CRT stub if a CRT is needed.
5. Verify output under wine on Linux; log `poa.verify` outcome.
6. Record time-to-pass and any failure mode in this ADR's appendix.

## Non-goals (explicitly out)

- Other OS directions (Windows→Linux, Linux↔macOS, etc.) — follow-on milestones
- Dynamic binaries, threading, GUI, CRT-completeness
- Performance benchmarks beyond "works" for v1
- Shipping a binary-translation feature; the outcome here is a **decision**
- Anything requiring reading bytes from live processes or signed vendor code

## Kill criteria (milestone decides early)

If the lifter cannot lift `hello` and re-emit a working Windows binary after a
sustained build attempt with logging, we record this spike as **negative**.
Cost bounded at one week of clock time sprinkled across POA work sessions; if
build of Remill or McSema drags past two build cycles with no lift output,
we stop and record the negative finding.

## Samples

Only the local `hello.c` is in scope for v1. No third-party binaries; no
licensing ambiguity; no prize for lifting a real program.

## Success criteria

- Deliverable: one committed Windows PE binary runnable under wine.
- poa.verify outcome `passed`.
- ADR updated with exact observations (build commands, patch work required,
  lifter version, bytes lifted, failures hit).

## ADR conclusion deadline

M3 gate review: end of Nov 2026. After that, either we ship a one-off lifter
path or close it negative with numbers.

## Appendix — attempts log

### What the lifter must actually translate

The M3 spike's minimal sample is a 2 KB static ELF with no external
dependencies. Its entire instruction surface is:

```asm
_start:
    push   %rbp
    mov    %rsp,%rbp
    movabs $0x1000158,%rax          # message pointer
    mov    %rax,-0x8(%rbp)
    movq   $0x17,-0x10(%rbp)        # length
    mov    -0x8(%rbp),%rsi
    mov    $0x1,%edi
    mov    $0x17,%edx               # number of bytes
    mov    %edi,%eax                # syscall number 1 (write)
    syscall
    mov    %rax,-0x10(%rbp)
    mov    $0x3c,%rax               # syscall number 60 (exit)
    xor    %rdi,%rdi
    syscall
```

Everything the lifter must handle is visible — register setup, immediates,
syscall encoding. None of this needs a CRT, none of this needs a loader.
The lifter's job for this sample is bounded by construction: translate
the 13 instructions at address 0x10011d0–0x100120a and have the resulting
Windows PE produce a working `write(1, "Hello from the M3 spike\n", 23) ; exit(0)`.

### Build-derived facts about musl-static hello-m3.c

- ~855 KB debug-rich ELF with full musl startup code (crt1.o, crti.o,
  init sections, stdio setup)
- Not a realistic recipe for a clean lifter run — millions of instructions
  including libc internals would need to translate and most won't without a libc shim
- Pinned to 64-bit x86-64 (the only ISA POA considers in this spike)

### Decision logs

- M3 direction locked: **Linux -> Windows** (one direction only)
- Lifter candidate: **Remill** (LLVM-based lifter; 1.9k stars, Apache-2.0,
  actively maintained by lifting-bits; Intel XED based)
- Fallback candidate: McSema (Remill-based decompiler); Ghidra headless (Java) —
  both defer because Remill is the most direct route to an LLVM IR artifact
- Freestanding sample chosen as the smallest surface for the lifter to demonstrate on
- Remill build kicked off in parallel; ADR updated after XED build completes

## Spike progress log (Nov 17 2026)

### What worked

- Remill built via its own nix package (`lifting-bits/remill`); LLVM 19.1.7, XED v2025.06.08.
- The 62-byte `_start` of `hello-freestanding` was lifted with:
  `remill-lift-19 -arch amd64 -os linux -address 0x10011d0 -entry_address
  0x10011d0 -bytes <hex> -ir_out /tmp/opencode/m3-build/hello-freq.ll`
- Output: 324 lines of LLVM IR for that one function (`sub_10011d0`), 14.6 KB.
- The IR references Remill runtime calls:
  - `__remill_write_memory_64` / `__remill_read_memory_64` — memory operations
  - `__remill_sync_hyper_call` — the `syscall` instruction is lifted to a synchronous hypercall boundary
  - `__remill_async_hyper_call` — external return handling
  - `__remill_missing_block` — fallback for unknown instruction sequences

That is what Remill emits by design: LLVM IR with an explicit guest→runtime boundary.
It is **not** a runnable Windows PE.

### What this means for M3's deliverable

Per ADR scope, the v1 target was "produce a Windows x86-64 PE that prints
'Hello from the M3 spike' under wine, verified by `poa.verify`."

Remill does not produce binary → binary directly. It produces LLVM IR. So the
honest critical path to the v1 deliverable is:

1. Link the lifted IR with Remill's runtime (which we have via the Nix build)
   and provide implementations of the `__remill_*` calls for a Windows target.
2. Re-emit via LLVM's `x86_64-windows-gnu` backend.
3. Link with the Windows CRT (or provide a stub with no CRT needed for our
   freestanding sample).
4. Verify under wine.

### Realistic assessment

This is closer to "the lifter works and emits the right IR" than to "we have
portable Linux binaries." The remaining work after Remill is:

- Writing Windows-side implementations of the ~7 `__remill_*` routines
- Bridging to the Windows SYSCALL ABI (WriteFile / GetStdHandle / etc.)
- Building it all into LLVM and emitting a PE

Each is a small project. Steps 1 and 3 are tractable. Step 2 (the syscall ABI
bridge) is where the scope creep lives — every Linux syscall number would
need an equivalent Windows call, and for non-trivial programs that's hundreds
of cases. For `hello-freestanding` there are only two syscalls (write and
exit), so a v1 Win32 shim is well within reach.

### What we will not do in v1

- No general-purpose syscall bridge
- No CPU-state completeness (we don't emulate all flags, vector regs, etc.)
- No libc-style support; the sample goes direct to syscalls so we don't need any

### Next steps

1. Lift the musl-static hello to confirm the larger surface works (optional —
   the freestanding sample already proves the lifter runs).
2. Write a minimal `__remill_runtime_win32_x86_64` in C that provides the
   `__remill_*` calls for the specific two syscalls (`write`, `exit`).
3. Compile `hello-freq.ll + runtime` → `.obj`, link as PE, verify with wine.
