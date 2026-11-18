# GitLiMP binary recovery report

**Input:** `binary_test/gitlimp.exe` — Windows PE x86-64, Wails/Go GUI application, supplied 2026-11.
**Date:** 2026-11-18
**Input SHA-256:** `2d47893ca49e0745bb2c11509e9476a14aa46fab29f54713df77be5061343e76`
**Method:** POA MCP tools (`poa.go_buildinfo`, `poa.verify_embedded_assets`) — no decompiler required.

This document records exactly what can and cannot be extracted from this binary, and how the
Linux artifact in this directory was produced. Nothing here is "binary→binary"; read the
verdict at the bottom.

## Identity, read straight from the binary

`go version -m` on the PE reports:

| field | value |
|---|---|
| toolchain | go1.25.12 |
| module | `gitlimp` `(devel)` |
| build tags | `desktop,wv2runtime.download,production` |
| trimpath | true |
| CGO_ENABLED | 0 |
| GOOS / GOARCH / GOAMD64 | windows / amd64 / v1 |

Full dependency graph with h1 hashes (19 direct+indirect deps), reproduced in
`binary_test/gitlimp-buildinfo.json` — key pins: `wailsapp/wails/v2 v2.14.0`,
`wailsapp/go-webview2 v1.0.22`, `google/uuid v1.6.0`, `fsnotify/fsnotify v1.9.0`.

Embedded text blob, recovered verbatim: `{"version":"1.0.0"}`.

## What was recovered byte-identically from the binary

The Wails frontend (`frontend/dist`, embedded via Go `go:embed`) was rebuilt upstream from
the same lockfile/toolchain and located inside the binary with `poa.verify_embedded_assets`:

- **125 / 125 files located inside the binary.**
- **124 byte-identical** (exact byte offset + length in `gitlimp-assets-report.json`;
  5,769,814 bytes of located asset data — CSS/JS/fonts/images/KaTeX/mermaid bundles).
- **1 end-of-line-normalized** — `index.html` differs only in line endings/trailing newline
  (the exe was built on Windows with mixed CRLF artifacts); content otherwise identical.
- **0 not-found.** `sha256` per file is recorded in `gitlimp-assets-report.json`.

Cross-check: fresh upstream `vite build` produced content-hash filenames identical to the
names embedded in the exe (`index-BWFioNr4.js`, `index-D6Cx65yj.css`,
`katex-HP8lGamR.js`, `cynefin-VYW2F7L2-DD8-bDF7.js`, …) — i.e. the embedded frontend is
the upstream one, not a modified fork.

## What was NOT recovered from the binary (and what was done instead)

- **The Go backend (`main.go`, `app.go`) is machine code only.** Go source text is not
  present in a compiled binary. No decompilation of that code is claimed here.
  The backend logic was taken from the MIT-licensed upstream repository
  (`github.com/velo4705/gitlimp`), at dependency versions pinned by the buildinfo above.
  Backend source equivalence beyond that cannot be proven from the binary alone.
- **The Windows WebView2 COM surface does not exist on Linux.** No tool can translate
  `ICoreWebView2` COM calls into WebKitGTK calls at the byte level; that is a reimplementation,
  not a port. The Linux artifact was therefore built from the open-source backend with
  `-tags webkit2_41` (same platform tag the upstream `build.sh` uses).
- `gitlimp.exe` remains **untouched**; its sha256 is unchanged.

## The Linux artifact

`binary_test/gitlimp-linux-x86_64` — ELF x86-64, dynamically linked, WebKitGTK 4.1.
**SHA-256:** `471256675a507130030d974d1a40f523e9b4fe7bba73b938ec595c19dd162be1`
Verified to launch headlessly far enough to initialize WebKitGTK (`Overriding existing handler
for signal 10 … Ctrl+C detected` → clean exit 0).

## Verdict

- **Source-available port of an MIT project: yes, done.** Classification: **NEAR-LOSSLESS**
  (rebuilt from source + recovered embedded assets; the Windows exe is untouched).
- **Binary→binary for this input: no.** It is a Wails GUI bound to Edge WebView2 over COM on
  the NT ABI; a Linux equivalent must be compiled, not translated. Any claim of a drop-in
  translated ELF here would be fake.
- **What POA gained permanently:** `poa.go_buildinfo` (structured build metadata for any Go
  binary) and `poa.verify_embedded_assets` (byte-level proof/recovery of embedded assets with
  offsets + sha256), both registered as MCP tools and used to produce this report.

Binaries are intentionally **not** committed to git (17 MB + 16 MB); this directory carries
documentation and JSON evidence only.
