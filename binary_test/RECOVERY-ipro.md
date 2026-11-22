# Epson iProjection (iProV410Win_Web.exe) — extraction & recompile report

**Input:** `binary_test/iProV410Win_Web.exe` — PE32 (x86) GUI, self-extracting Epson iProjection V4.10 installer bootstrapper.
**SHA-256:** `0fc884cbdeb16e63704bcc60393496ff6401a24a277bcce6d7178e185ce47244`
**Method:** POA reverse-engineering path (7z / msiextract / ilspycmd / dotnet build).
**Date:** 2026-11-18
**Verdict up front:** the managed half of the app was extracted to source and recompiled
cleanly. It is a **Windows** net462 WPF binary, not a Linux one, and it is not standalone.
Full functionality on Linux is not attainable from this artifact. Details below.

## What the binary is

Self-extracting installer (`SetupIterateCabinetA`, `CDInst.cab`) carrying, per architecture:

| payload | size |
|---|---|
| InstDataX86 / Epson iProjection Ver.4.10.msi | 62.1 MB |
| InstDataX64 / Epson iProjection Ver.4.10.msi | 71.1 MB |
| InstDataARM64 / Epson iProjection Ver.4.10.msi | 70.9 MB |
| InstDataOld/ (legacy InstallShield payload) | ~4 MB |
| iProjection_Inst.exe (inner installer stub) | 2.3 MB |
| 34 languages × license/.mst | — |

Signature of the installer: PDB path `C:\work\src\iPro\MPP\MPC\Installer\InstallerModules\Web_Installer\Release\iProjection_Setup.pdb`, Vendor = SEIKO EPSON CORPORATION, all rights reserved.
This is **proprietary Epson software**; decompilation results were used for analysis only
and were NOT published or committed anywhere.

## MSI payload analysis (X86 extracted)

- 133 files. Main assembly **EMP_MPP.exe — .NET Framework 4.6.2, WPF (PresentationFramework), PlatformTarget=x86** → managed/UI half.
- **259 distinct `MppApi_*` P/Invoke entry points** from EMP_MPP.exe → native engine `EMP_MPPCore.dll` (2.4 MB; exports ~714 functions; HAS_DEBUG/HAS_LINENO/HAS_LOCALS, unwinded line info, no PDB shipped).
- Native engine stack: EMP_MPPCore → EMP_ENGN (298 exports) → EMP_ENDD (294) → EMP_FWSET (286) → WebRTCManager.dll (7.3 MB) → USB/HID kernel drivers (`x86/EMP_VHID.sys`, `EMP_VHIDKmdf.sys`) and `EpsonIddDriver.dll` (indirect display driver). ~58 native binaries total.

## Extraction results (managed half)

`ilspycmd -p --nested-directories EMP_MPP.exe` produced:

- 92 `.cs` files, **28,294 lines**, `EMP_MPP.csproj` (net462, WPF), BAML-compiled views embedded as resources, `app.config`, manifest, ico.

Decompiler repair required to compile (all mechanical, ~170 edits):

1. `((Type)(ref var)).Member` → `var.Member` (value-type member access mangling; 58 sites, 5 types).
2. `Resources.LZD_*` / `Properties.Resources.*` qualification (95 sites) — inherited `FrameworkElement.Resources` shadowed the static class.
3. `Keyboard.GetKeyStates|Modifiers & 1/& 2` → `(int)… & mask` (RP: KeyStates/ModifierKeys are flags enums).
4. `((Window)this).OnXxx(...)` → `base.OnXxx(...)` for protected overrides (5 sites).
5. Ambiguous `Image`/`CheckBox`/`ContextMenu`/`Control`/`PixelFormat`/`Screen` between WPF, Windows.Forms, System.Drawing (qualifiers/aliases).
6. `(MessageBoxOptions)0` fine; `(val2 - 1) switch` → `((int)val2 - 1) switch` (enum arithmetic); `DataGridLength.op_Implicit(x)` → `new DataGridLength(x)`; `ManagementObjectEnumerator` → `ManagementObjectCollection.ManagementObjectEnumerator`; `Screen.*` → `System.Windows.Forms.Screen.*`; `ThemeInfo` decoded; Geolocation WinRT awaiter replaced by direct `IAsyncOperation` poll (net462 has no SDK WinRT refs).

## Build result (verified)

`dotnet build` (dotnet-sdk_8, Microsoft.NETFramework.ReferenceAssemblies.net462 + Windows SDK contracts):

```
Build succeeded.
bin/Debug/net462/EMP_MPP.exe — PE32 executable, MS Windows 6.00 (GUI), Intel i386 Mono/.Net assembly, 1,071,104 bytes
SHA-256: bf409a717c481ee08e2eebdd0d2e58b2de0cc10a4fc43be48ff458ebadb11c59
```

The extracted source **compiles and re-links**. The rebuilt assembly is functionally the same
program as the original managed app modulo the repairs above, but it targets Windows and is not
standalone. The rebuilt DLL/EXE was kept in the build tree only — it is NOT committed to git
and was NOT distributed.

## What cannot be recompiled from this binary (the decisive block)

1. **EMP_MPPCore.dll and the native engine** — machine code. No .NET IL to decompile. Ghidra
   yields pseudo-C at best; pseudo-C for ~1,600 engine exports plus ~58 native modules is not
   compilable into a working engine without a from-scratch reimplementation. Projector protocol,
   WebRTC stack, EDID/HDCP handling, USB, media — all live here.
2. **WPF / .NET Framework 4.6.2** — Windows-only. There is no Linux build of
   PresentationFramework, and WPF is not in any .NET Core/.NET 8 line. Same program on Linux
   requires a **UI rewrite** (e.g., to Avalonia) + the engine problem from (1).
3. **Kernel drivers** (`EMP_VHID.sys`, `EMP_VHIDKmdf.sys`, `EpsonIddDriver`) — no Linux
   counterpart exists; an Indirect Display Driver is Windows-display-model specific.
4. `msiextract` bits (MSTs) and the update/CDN machinery are Windows-installer plumbing.

Bottom line: **"Extract the source and recompile to Linux, with full functionality" is not
achievable for this input, by any tool, today.** The achievable goals are:

- **(a) Rebuilt Windows binary from extracted source — done** (see Build result above).
- **(b) Linux full-functionality port — requires Epson source or a clean-room reimplementation**
  of the engine + UI rewrite; kernel drivers have no path at all. This is an engineering program,
  not a conversion.
- **(c) Linux projector control with partial functionality** — a clean-room PJLink/ESC-VP.net
  client can drive power/input/mute/shutter on Epson projectors; it would not be Epson's app.

Binaries in this directory are not committed to git. Extracted decompiled source is not in the
repository either, for the same reason.

## Direct conversion attempts (2026-11-22)

Three different mechanisms were tried against the extracted payload; none produced a runnable
Linux equivalent. Measured evidence:

1. **Lift the managed UI directly.** `poa.lift` on `EMP_MPP.exe` (1,052,512 bytes) succeeded,
   but `poa.recompile` produced only a 4,760-byte ELF object with 8 undefined symbols: the PE
   entry is a CLR stub, the real program is IL, not x86-64. `poa.assess_portability`: rung 6
   `impossible` (WPF / WinForms).
2. **Lift the native engine.** `EMP_MPPCore.dll` has a 1,795,676-byte `.text` and **632 imported
   functions across 17 Windows DLLs** (KERNEL32, USER32, GDI32, gdiplus, WS2_32, WININET, …).
   A 4 KB slice failed to lift with the installed i386 lifter; even if lifted, a native shim
   would need hundreds of functions per module. Verdict: rung 5 `blocked`.
3. **Retarget decompiled source to Linux.** 92 C# files / 28k lines rebuild for net462 Windows.
   Retargeting to `net8.0` on Linux yields **2,020 compile errors** after fixing 58 decompiler
   artifacts — overwhelmingly missing `System.Windows.*` WPF types. That is a UI rewrite, not
   a port.

No attempt produced a runnable binary, let alone one that looks the same. Unlike the tiny PE in
`docs/PORTABILITY.md`, this artifact has no small import surface to implement. The remaining
path is the rights-holder source workstream in `docs/PORT-EPSON-source.md`.
