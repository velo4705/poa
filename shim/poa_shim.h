/*
 * poa-shim v0.1.0 — the bounded POSIX↔Win32 compatibility layer POA ports against.
 *
 * Scope (v1, the "80% spine"): path conversion, temp files, monotonic time,
 * errno/GetLastError translation. Broader shim areas are spec'd in docs/SHIM.md
 * and grow from poa.scan_dependencies evidence, never speculatively.
 *
 * Build: cc (POSIX) or zig cc -target x86_64-windows-gnu (Windows).
 */
#ifndef POA_SHIM_H
#define POA_SHIM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define POA_SHIM_VERSION "0.1.0"

/* Convert src to the platform's native path convention.
 * POSIX: identity copy. Windows: sep insert + leading-slash → drive-relative.
 * Returns dst. Truncation semantics: always NUL-terminated, returns dst; the
 * length return is strlen(dst). */
size_t poa_path_to_target(char *dst, size_t dst_size, const char *src);

/* Get the platform temp directory (no trailing separator beyond "/"). */
int poa_temp_dir(char *dst, size_t dst_size);

/* mkstemp(3) semantics: tmpl must end in "XXXXXX"; replaced with a unique name.
 * Returns an fd (POSIX) or a handle wrapper encoded as fd-compatible int (Win), or -1. */
int poa_mkstemp(char *tmpl);

/* Monotonic nanoseconds (CLOCK_MONOTONIC / QueryPerformanceCounter). */
uint64_t poa_monotonic_ns(void);

/* Sleep for ms milliseconds; returns 0. */
int poa_sleep_ms(uint32_t ms);

/* Windows last-error → POSIX errno. On POSIX this is just errno itself. */
int poa_last_error_to_errno(void);

/* POSIX errno → nearest Win32 code. */
int poa_errno_to_win32(int err);

#ifdef __cplusplus
} /* extern "C" */
#endif
#endif
