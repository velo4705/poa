# Source-based port contract: Epson iProjection V4.10 → Linux

**Status:** accepted workstream, blocked on source intake
**Owner:** POA
**Precondition:** you are the rights holder or authorized (Epson internal / partner). No Epson
source is present in the workspace as of 2026-11-21; nothing here has started.
**Evidence:** `binary_test/RECOVERY-ipro.md`, `docs/ADR-M3-binary-frontier.md`.

## 1. Intake contract — what must be supplied

Required to start:

- UI sources: WPF `.csproj`, `.xaml` + code-behind, resources, `app.config`, manifest.
- Engine sources: `EMP_MPPCore`, `EMP_ENGN`, `EMP_ENDD`, `EMP_FWSET`, `WebRTCManager` — C/C++
  sources, private headers, `.vcxproj`/CMake/nmake files, third-party dependency versions.
- Build/repro info: exact toolchain, target framework (net462), SDK versions, sign/copy steps.
- Rights confirmation and redistribution scope (internal-only vs publishable).

Optional but strongly desired:

- Projector protocol documents (Epson network/USB control, ESC/VP.net, PJLink support matrix).
- Driver sources: `EMP_VHID.sys`, `EMP_VHIDKmdf.sys`, `EpsonIddDriver` spec.
- Feature-priority list: which functions must be LOSSLESS, which may be DEGRADED, which can be dropped.

Drop these into a directory and give me its path (e.g. `/home/nix/Projects/epson-source`), or
provide an accessible repo URL. I will not fetch or publish proprietary code on my own.

## 2. Target architecture

```
Linux
 ├─ UI: Avalonia 11 / .NET 8     ← translate WPF XAML + code-behind (mechanical subset, manual rest)
 │    └─ bindings/viewmodels     ← mostly portable (INotifyPropertyChanged, commands)
 ├─ engine: libmppengine.so      ← port C/C++ with CMake + gcc/clang
 │    ├─ 259-entry MppApi ABI    ← preserve exported C ABI shape so managed code stays close to source
 │    ├─ projector discovery/connect (network + USB)
 │    ├─ thumbnail/delivery + config
 │    └─ WebRTC (libwebrtc / GStreamer) — DEGRADED until parity-tested
 └─ platform adapters
      ├─ config: XDG dirs + JSON  ← replaces registry/ini paths
      ├─ USB HID: uhid/evdev     ← replaces EMP_VHID.sys
      ├─ display: Wayland/X11 + PipeWire remote desktop ← replaces Windows IDD
      └─ logging/diagnostics: journald/plain files ← replaces OutputDebugString
```

## 3. Work breakdown and gates

| Phase | Deliverable | Gate |
|---|---|---|
| P0 intake | source tree inventory, dependency map, build reproducibility | Windows build from source succeeds in a VM, matching installer's feature set |
| P1 engine | CMake build of engine `.so`; 259 exported `MppApi_*` symbols; unit tests | nm shows full ABI; core search/connect tests pass in a projector simulator |
| P2 UI | Avalonia project, XAML + viewmodel translation; binds to engine ABI | UI builds/runs on Linux; all screens reachable |
| P3 adapters | XDG config, uhid/evdev, PipeWire/Wayland capture, WebRTC port | feature matrix marked LOSSLESS / NEAR-LOSSLESS / DEGRADED / unsupported per item |
| P4 verification | POA port report, CI lane, artifact | honest classification; no silent degradation; 1 real projector tested if available |
| P5 package | AppImage/flatpak or distro package | installs and launches on a clean Linux desktop |

## 4. Fidelity policy

- **LOSSLESS**: behavior verified by the source project's own tests on both OSes.
- **NEAR-LOSSLESS**: behavior equivalent; platform-native UI/layout differences recorded.
- **DEGRADED**: explicit reason per item — e.g. WebRTC codec set, virtual display feature,
  USB-key handling. No silent dropping.
- **Unsupported**: driver-level features with no Linux equivalent; stated in the port report.

## 5. Why this is not the binary→binary path

The installer's managed half was extracted and recompiled during M3, but WPF is Windows-only and
the native engine has no source in the binary. This contract starts from rights-holder source;
without it, the only honest outcomes are the ones in `docs/ADR-M3-binary-frontier.md`.
