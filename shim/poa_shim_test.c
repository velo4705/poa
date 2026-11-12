/* poa-shim compliance test — exits non-zero if any check fails. */
#include "poa_shim.h"
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>
#if defined(_WIN32)
#include <io.h>
#else
#include <unistd.h>
#endif

static int failures = 0;
#define CHECK(name, cond) do { \
    if (cond) { printf("PASS  %s\n", name); } \
    else      { printf("FAIL  %s\n", name); failures++; } \
} while (0)

int main(void)
{
    /* monotonic clock is monotonic */
    uint64_t t0 = poa_monotonic_ns();
    uint64_t t1 = poa_monotonic_ns();
    CHECK("monotonic_non_decreasing", t1 >= t0);

    /* sleep actually sleeps at least ~ms */
    uint64_t before = poa_monotonic_ns();
    poa_sleep_ms(20);
    uint64_t delta = poa_monotonic_ns() - before;
    CHECK("sleep_ms_actually_sleeps", delta >= 10000000ull); /* >= 10 ms */

    /* temp dir resolvable and usable */
    char tmp[512];
    CHECK("temp_dir_ok", poa_temp_dir(tmp, sizeof tmp) == 0 && tmp[0] != '\0');
    printf("       temp_dir = %s\n", tmp);

    /* mkstemp creates a unique, writable file */
    char tmpl[512];
    snprintf(tmpl, sizeof tmpl, "%.200s/poa-shim-test-XXXXXX", tmp);
    int fd = poa_mkstemp(tmpl);
    CHECK("mkstemp_ok", fd >= 0);
    if (fd >= 0) {
        const char *msg = "poa";
        ssize_t w = -1;
#if defined(_WIN32)
        w = _write(fd, msg, 3);
        _close(fd);
#else
        w = write(fd, msg, 3);
        close(fd);
#endif
        CHECK("mkstemp_write_ok", w == 3);
        remove(tmpl);
    }

    /* path conversion is self-consistent per platform */
    char path[512];
    size_t n = poa_path_to_target(path, sizeof path, "a/b/c");
    CHECK("path_to_target_bounded", n > 0 && n < sizeof path);
    printf("       path_to_target('a/b/c') = %s\n", path);

    /* errno → win32 table, exact pairs (POSIX hosts: identity mapping) */
#if defined(_WIN32)
    CHECK("errno_to_win32[ENOENT]", poa_errno_to_win32(ENOENT) == 2 /* ERROR_FILE_NOT_FOUND */);
    CHECK("errno_to_win32[EACCES]", poa_errno_to_win32(EACCES) == 5 /* ERROR_ACCESS_DENIED */);
    CHECK("errno_to_win32[EEXIST]", poa_errno_to_win32(EEXIST) == 0x50 /* ERROR_ALREADY_EXISTS = 80 */);
    CHECK("errno_to_win32[EINVAL]", poa_errno_to_win32(EINVAL) == 87 /* ERROR_INVALID_PARAMETER */);
#else
    CHECK("errno_to_win32_identity[ENOENT]", poa_errno_to_win32(ENOENT) == ENOENT);
    CHECK("errno_to_win32_identity[EACCES]", poa_errno_to_win32(EACCES) == EACCES);
    CHECK("errno_to_win32_identity[EEXIST]", poa_errno_to_win32(EEXIST) == EEXIST);
    CHECK("errno_to_win32_identity[EINVAL]", poa_errno_to_win32(EINVAL) == EINVAL);
#endif

    if (failures) { printf("\n%d CHECK(S) FAILED\n", failures); return 1; }
    printf("\nall poa-shim checks passed\n");
    return 0;
}
