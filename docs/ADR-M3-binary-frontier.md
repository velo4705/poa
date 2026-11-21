# ADR: M3 binary frontier — what POA will and will not claim

**Status:** accepted
**Date:** 2026-11-21
**Context:** M3 goal was to decide, with evidence, whether static binary retranslation belongs in the product.
Evidence gathered from the two binaries supplied in `binary_test/` is recorded in
`RECOVERY.md` (GitLiMP) and `RECOVERY-ipro.md` (Epson iProjection).

## Evidence (measured, not asserted)

### gitlimp.exe — Wails/Go GUI
- 17 MB PE; `poa.lift` lifted all 17 MB to LLVM bitcode; `poa.recompile` produced a 23 KB ELF relocatable.
- Link fails: `__remill_*` symbols plus Win32 kernel32/COM/WebView2 calls. No Linux ABI shim exists in POA.
- Frontend: 125/125 `frontend/dist` files located in the exe (124 byte-exact, 1 EOL-normalized), 5.77 MB.
- Go buildinfo recovered: go1.25.12, 19 deps with h1 hashes, tags `desktop,wv2runtime.download,production`.
- Backend source is machine code only. MIT upstream source rebuilt with `-tags webkit2_41` →
  `binary_test/gitlimp-linux-x86_64`, launches and initializes WebKitGTK. **Classification: source-recompile, NEAR-LOSSLESS.**

### iProV410Win_Web.exe — Epson iProjection V4.10 installer
- 187 MB self-extracting installer; 3 MSIs + inner installer; 133 files in the X86 MSI.
- Managed half decompiled to 92 C# files / 28,294 lines; rebuilt successfully on Linux with
  dotnet 8 + net462 reference assemblies → PE32 .NET assembly. **Extraction and recompilation work.**
- But: WPF has no Linux target; the app P/Invokes 259 `MppApi_*` functions into a 2.4 MB native
  engine (≈1,600 exports across the engine stack, 7.3 MB WebRTC module), plus Windows kernel drivers.
  Native source is not recoverable from the binary; pseudo-C is not a compilable engine.
  **Classification: full-functionality Linux port is not attainable from this artifact.**

## Decision

1. **Binary→binary is not a product feature.** Ship the honest primitives instead:
   `poa.lift`, `poa.recompile`, `poa.go_buildinfo`, `poa.verify_embedded_assets`.
   Each reports its exact scope and blockers; none claims a runnable foreign binary.
2. **Source-based ports remain the product path** (M2 corpus, GitLiMP). For proprietary
   GUI binaries, a Linux port requires source rights + a real retarget — see `PORT-EPSON-source.md`.
3. **Wine is a compatibility layer, not a port.** May be mentioned as a DEGRADED fallback in a
   port report; never silently substituted.
4. **No work to fix the Epson installer as a binary.** Its only legal/technical path is source.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Remill lift + recompile for GUI binaries | Ends at an object file; requires reimplementing the source OS ABI + COM/webview. No Linux shim exists. |
| Wine inside POA | Compatibility layer, not native; explicitly out of scope. |
| Full decompilation to recompile native engine | 1,600+ exports, no source semantics; pseudo-C is not compilable-to-working. Multi-person-year rewrite. |
| Claiming GitLiMP's Linux build is binary→binary | It is a source rebuild from MIT upstream; claiming otherwise would be dishonest. |

## Consequences / reopen conditions

- M3 closes as a **research spike with a negative product decision**, documented with measurements.
- Reopen binary→binary if: a maintained POSIX Win32 ABI shim exists AND a GUI backend maps the
  source webview to WebKitGTK without reimplementation — neither is true today.
- The source-based Epson port is accepted as a separate, gated workstream
  (`PORT-EPSON-source.md`), contingent on the rights-holder supplying source or specs.
