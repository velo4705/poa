# POSIX ↔ Win32 Shim — M2 Compliance Matrix

The bounded API surface POA's compat-shim covers for same-ISA ports
(Windows x86-64 ↔ Linux x86-64). Everything grows by demand — from what
`poa.scan_dependencies` reports as imported, never from guessing.

**Status legend:** `planned` · `sketched` · `working` · `verified` · `wontfix (documented)`

**v0.1.0 shipped** (items 2, 7, 10, 15): built & compliance-tested on Linux (all checks PASS);
compiled+linked for x86_64-windows-gnu (586 KB PE, `MZ` magic checked) but **never run** —
no Windows/Wine on this host. Windows runtime verification rides on CI (windows-latest) or your box.

| # | POSIX / Win32 area | Maps to | Status | Notes |
|---|---|---|---|---|
| 1 | File I/O (`open/close/read/write/stat`) ↔ `CreateFileW/ReadFile/GetFileAttributesW` | both directions |planned| Path separator, `\`→`/`, drive-letter policy table |
| 2 | Paths & registry (`C:\Program Files`, `%USERPROFILE%`) ↔ XDG dirs | shim |working| Separator normalization + temp-dir resolution done (`poa_path_to_target`, `poa_temp_dir`); registry hive not started |
| 3 | Sockets (`socket/bind/connect/accept`, `select/poll/epoll`) | Winsock2 |planned| `epoll` → `WSAEventSelect` or IOCP fallback |
| 4 | Threads (`pthread_*` ↔ `CreateThread/WaitForSingleObject`) | shim |planned| condition variables map poorly — document edge cases |
| 5 | Signals (`SIGINT`, `SIGTERM`, `SIGKILL`) | Windows console events / `generate_console_ctrl_event` |planned| `SIGUSR1/2` → named events |
| 6 | Console I/O (`isatty`, ANSI escapes) | Win32 console API / virtual terminal processing |planned| enable VT processing on Win10+; fallback = strip codes |
| 7 | Time (`clock_gettime`, `nanosleep`) | `QueryPerformanceCounter` + `Sleep` |working| monotonic ns + ms sleep implemented & unit-tested |
| 8 | Environment (`getenv/setenv`) | `GetEnvironmentVariableW` |working (concept)| case-insensitivity mismatch — normalize |
| 9 | Dynamic loading (`dlopen/dlsym`) | `LoadLibrary/GetProcAddress` |planned| `dlerror` semantics |
| 10 | Temp files / unique names (`mkstemp`) | `GetTempFileNameA` + `_open(_O_EXCL)` |working| implemented & unit-tested |
| 11 | Pipes / fork | `CreateProcessW`, anonymous pipes |planned| **no `fork()` on Windows** — document, offer posix_spawn-class alternative |
| 12 | File permissions (`chmod 0644`) | ACLs |planned| lossy by nature — declare in port report |
| 13 | `mmap` vs `CreateFileMapping` | shim |planned| shared memory OK; `MAP_FIXED` = impossible, documented |
| 14 | `umask` | no-op with warning |planned| |
| 15 | `errno` ↔ `GetLastError` | translation table |working| 14-code table, exact-pair unit checks on Windows, identity on POSIX |
| 16 | GUI / windowing | **out of M2** — M5's job |planned (M5)| e.g. Win32 GUI ↔ X11/Wayland/Cocoa is a different subsystem |
| 17 | DirectX/D3D | **never at M2** |wontfix (docs)| see M6; DX→Vulkan is its own milestone |
| 18 | Console-only I/O quirks (CRT `_getwch`, `kbhit`) | `_kbhit/_getwch` same names on MSVC |working (concept)| MSVC UCRT keeps many POSIX-ish names |

## Compliance policy

- Every mapping that is lossy (permissions, signals, fork) is declared in the
  port report as `degraded.<key>` — never silent.
- `fork()` absence is the single most-likely failure mode of "it compiled but
  misbehaves": any project using raw `fork` is flagged `needs-human` by the
  discrepancy mapper.
- Test corpus: the M2 gate requires ≥ 8 license-clean CLI/server-class projects
  building and passing their own test suites on both Windows and Linux from one
  manifest.

## What this is not

- Not a promise of Win32↔POSIX completeness — it's the growing surface POA
  actually ports, grown from `poa.scan_dependencies` evidence.
- Not Wine. Wine took decades and runs Windows binaries via a syscall thunk +
  full Win32 reimplementation. POA's compat-shim is narrower: it targets the
  **POSIX subset that source uses**, translated at build time (source) or at
  runtime (compat-runtime, clearly labeled).
