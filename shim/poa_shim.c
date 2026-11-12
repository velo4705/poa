#define _POSIX_C_SOURCE 200809L
#include "poa_shim.h"

#if defined(_MSC_VER)
#define POA_TLS __declspec(thread)
#else
#define POA_TLS __thread
#endif

#include <string.h>
#include <stdio.h>

#if defined(_WIN32) || defined(__CYGWIN__)
#define POA_WIN32 1
#include <windows.h>
#include <io.h>
#include <stdlib.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <errno.h>
#else
#include <stdlib.h>
#include <time.h>
#include <unistd.h>
#include <errno.h>
#include <dlfcn.h>
#endif

static int last_error_to_errno_internal(void);

size_t poa_path_to_target(char *dst, size_t dst_size, const char *src)
{
    if (!dst || dst_size == 0) return 0;
    if (!src) { dst[0] = '\0'; return 0; }
#if POA_WIN32
    /* / → \; leading '/' becomes root-of-current-drive (\) */
    size_t j = 0;
    for (size_t i = 0; src[i] && j + 1 < dst_size; i++) {
        char c = src[i];
        dst[j++] = (c == '/') ? '\\' : c;
    }
    dst[j] = '\0';
    return j;
#else
    size_t n = strnlen(src, dst_size - 1);
    memcpy(dst, src, n);
    dst[n] = '\0';
    return n;
#endif
}

int poa_temp_dir(char *dst, size_t dst_size)
{
#if POA_WIN32
    DWORD len = GetTempPathA((DWORD)dst_size, dst);
    if (len == 0 || len >= dst_size) return -1;
    return 0;
#else
    const char *t = getenv("TMPDIR");
    if (!t || !*t) t = "/tmp";
    size_t n = strnlen(t, dst_size - 1);
    memcpy(dst, t, n);
    dst[n] = '\0';
    return 0;
#endif
}

int poa_mkstemp(char *tmpl)
{
#if POA_WIN32
    /* mkstemp(3) semantics on Windows: template IS the full path with
     * "XXXXXX" as the unique-name placeholder. Generate a candidate with
     * an explicit create-exclusively loop — no GetTempFileName (its 3-char
     * prefix limit made the old code produce garbage). */
    size_t n = strnlen(tmpl, 4096);
    if (n < 6 || strncmp(tmpl + n - 6, "XXXXXX", 6) != 0) { errno = EINVAL; return -1; }
    char prefix[4096];
    memcpy(prefix, tmpl, n - 6);
    prefix[n - 6] = '\0';
    DWORD pid = GetCurrentProcessId();
    DWORD tick = GetTickCount();
    for (int attempt = 0; attempt < 1000; attempt++) {
        unsigned hash = (unsigned)(pid * 2654435761u) ^ (unsigned)(tick * 40503u) ^ (unsigned)(attempt * 2246822519u);
        char candidate[4104];
        if (snprintf(candidate, sizeof candidate, "%s%06x", prefix, hash & 0xffffffu) < 0) {
            errno = ENAMETOOLONG;
            return -1;
        }
        int fd = _open(candidate, _O_CREAT | _O_EXCL | _O_RDWR | _O_BINARY, _S_IREAD | _S_IWRITE);
        if (fd >= 0) {
            if (strlen(candidate) >= 4096) { _close(fd); errno = ENAMETOOLONG; return -1; }
            memcpy(tmpl, candidate, strlen(candidate) + 1);
            return fd;
        }
        if (errno != EEXIST) return -1; /* ACL, disk full, readonly dir — report the real error */
    }
    errno = EEXIST; /* 1000 consecutive collisions: something is very wrong */
    return -1;
#else
    return mkstemp(tmpl);
#endif
}

uint64_t poa_monotonic_ns(void)
{
#if POA_WIN32
    static LARGE_INTEGER freq;
    static int have_freq = 0;
    LARGE_INTEGER now;
    if (!have_freq) { QueryPerformanceFrequency(&freq); have_freq = 1; }
    QueryPerformanceCounter(&now);
    return (uint64_t)((double)now.QuadPart * 1e9 / (double)freq.QuadPart);
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
#endif
}

int poa_sleep_ms(uint32_t ms)
{
#if POA_WIN32
    Sleep(ms);
    return 0;
#else
    struct timespec req = { .tv_sec = ms / 1000, .tv_nsec = (long)(ms % 1000) * 1000000L };
    return nanosleep(&req, NULL);
#endif
}

/* ------- errno translation -------
 * Subset covering the codes that plausibly drive control flow. Both tables are
 * deliberately small and explicit — anything unmapped degrades to EIO/EINVAL
 * (documented), never to a guessed constant. */

#if POA_WIN32
static int last_error_to_errno_internal(void)
{
    DWORD e = GetLastError();
    switch (e) {
    case ERROR_SUCCESS:                 return 0;
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
    case ERROR_INVALID_DRIVE:           return ENOENT;
    case ERROR_ACCESS_DENIED:
    case ERROR_WRITE_PROTECT:
    case ERROR_INVALID_FUNCTION:        return EACCES;
    case ERROR_FILE_EXISTS:
    case ERROR_ALREADY_EXISTS:          return EEXIST;
    case ERROR_INVALID_PARAMETER:
    case ERROR_BAD_ARGUMENTS:           return EINVAL;
    case ERROR_NOT_ENOUGH_MEMORY:
    case ERROR_OUTOFMEMORY:             return ENOMEM;
    case ERROR_SHARING_VIOLATION:       return EBUSY;
    case ERROR_TOO_MANY_OPEN_FILES:     return EMFILE;
    case ERROR_INVALID_HANDLE:          return EBADF;
    case ERROR_BROKEN_PIPE:             return EPIPE;
    case ERROR_DISK_FULL:               return ENOSPC;
    case ERROR_HANDLE_EOF:              return 0; /* EOF is not an errno */
    case ERROR_NO_MORE_FILES:           return ENOENT;
    case ERROR_PIPE_CONNECTED:          return EPIPE;
    case ERROR_OPERATION_ABORTED:       return EINTR;
    case ERROR_NOT_SUPPORTED:           return ENOSYS;
    default:                            return EIO;
    }
}

int poa_last_error_to_errno(void) { return last_error_to_errno_internal(); }

int poa_errno_to_win32(int err)
{
    switch (err) {
    case 0:      return ERROR_SUCCESS;
    case ENOENT: return ERROR_FILE_NOT_FOUND;
    case EACCES: return ERROR_ACCESS_DENIED;
    case EEXIST: return ERROR_ALREADY_EXISTS;
    case EINVAL: return ERROR_INVALID_PARAMETER;
    case ENOMEM: return ERROR_NOT_ENOUGH_MEMORY;
    case EBUSY:  return ERROR_SHARING_VIOLATION;
    case EMFILE: return ERROR_TOO_MANY_OPEN_FILES;
    case EBADF:  return ERROR_INVALID_HANDLE;
    case EPIPE:  return ERROR_BROKEN_PIPE;
    case ENOSPC: return ERROR_DISK_FULL;
    case EINTR:  return ERROR_OPERATION_ABORTED;
    case ENOSYS: return ERROR_NOT_SUPPORTED;
    default:     return ERROR_GEN_FAILURE;
    }
}
#else
static int last_error_to_errno_internal(void) { return errno; }

int poa_last_error_to_errno(void) { return last_error_to_errno_internal(); }

int poa_errno_to_win32(int err) { (void)err; return err; } /* identity: no Win32 on POSIX hosts */
#endif

/* ------- item 6: console ------- */
int poa_console_enable_vt(void)
{
#if POA_WIN32
    HANDLE hOut = GetStdHandle(STD_OUTPUT_HANDLE);
    HANDLE hErr = GetStdHandle(STD_ERROR_HANDLE);
    DWORD mode;
    int enabled = 0;
    if (hOut != INVALID_HANDLE_VALUE && GetConsoleMode(hOut, &mode)) {
        if (SetConsoleMode(hOut, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING)) enabled = 1;
    }
    if (hErr != INVALID_HANDLE_VALUE && GetConsoleMode(hErr, &mode)) {
        if (SetConsoleMode(hErr, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING)) enabled = 1;
    }
    return enabled;
#else
    return isatty(STDOUT_FILENO);
#endif
}

int poa_is_console(void)
{
#if POA_WIN32
    DWORD mode;
    HANDLE hOut = GetStdHandle(STD_OUTPUT_HANDLE);
    return (hOut != INVALID_HANDLE_VALUE && GetConsoleMode(hOut, &mode)) ? 1 : 0;
#else
    return isatty(STDOUT_FILENO);
#endif
}

/* ------- item 9: dlopen without libdl ------- */
void *poa_dlopen(const char *name, int flags)
{
    (void)flags;
#if POA_WIN32
    if (!name) return (void *)GetModuleHandleA(NULL);   /* passing NULL → main module, like dlopen(NULL) */
    return (void *)LoadLibraryA(name);
#else
    return dlopen(name, flags ? flags : RTLD_LAZY);
#endif
}

void *poa_dlsym(void *handle, const char *symbol)
{
#if POA_WIN32
    return (void *)GetProcAddress((HMODULE)handle, symbol);
#else
    return dlsym(handle, symbol);
#endif
}

int poa_dlclose(void *handle)
{
#if POA_WIN32
    /* don't treat failure as fatal: FreeLibrary crash vs. returning nonzero — report nonzero */
    return FreeLibrary((HMODULE)handle) ? 0 : -1;
#else
    return dlclose(handle);
#endif
}

const char *poa_dlerror(void)
{
#if POA_WIN32
    static POA_TLS char buf[512];
    DWORD e = GetLastError();
    if (e == 0) { buf[0] = '\0'; return NULL; }
    DWORD n = FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                             NULL, e, 0, buf, sizeof buf, NULL);
    if (n == 0) buf[0] = '\0';
    /* trim trailing newline FormatMessage appends */
    size_t len = strnlen(buf, sizeof buf);
    while (len > 0 && (buf[len-1] == '\n' || buf[len-1] == '\r')) buf[--len] = '\0';
    return buf;
#else
    return dlerror();
#endif
}
