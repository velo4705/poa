#include <stddef.h>
/* M3 spike A — tiny Win32 hello program built as a Windows PE.
 *
 * Uses only the Win32 surface area Remill can feasibly lift:
 *   GetStdHandle(STD_OUTPUT_HANDLE)
 *   WriteFile(hOut, msg, len, &written, NULL)
 *   ExitProcess(0)
 *
 * No printf, no msvcrt, no crt startup — pure Win32.
 */
typedef unsigned int UINT;
typedef int BOOL;
typedef unsigned long DWORD;
typedef unsigned long long ULONGLONG;
typedef void *HANDLE;
typedef HANDLE HINSTANCE;
typedef char *LPSTR;
typedef const char *LPCSTR;
typedef void *LPVOID;
typedef const void *LPCVOID_;
typedef void *PVOID;
typedef int WINBOOL;
#define TRUE 1
#define FALSE 0
#define STD_OUTPUT_HANDLE ((DWORD)-11)
#define INVALID_HANDLE_VALUE (HANDLE)(UINT64)0xffffffffffffffffULL

extern HANDLE __stdcall GetStdHandle(DWORD);
extern BOOL __stdcall WriteFile(HANDLE, LPCVOID_, DWORD, DWORD *, void *);
extern void __stdcall ExitProcess(UINT);
#define ULONGLONG_T UINT64
typedef unsigned long long UINT64;

int __stdcall WinMain(HINSTANCE hInst, HINSTANCE hPrevInst, LPSTR lpCmdLine, int nCmdShow) {
    (void)hInst; (void)hPrevInst; (void)lpCmdLine; (void)nCmdShow;
    const char *msg = "Hello from the M3 spike\n";
    DWORD len = 0; while (msg[len]) len++;
    DWORD written = 0;
    HANDLE hOut = GetStdHandle(STD_OUTPUT_HANDLE);
    if (hOut == INVALID_HANDLE_VALUE) return 1;
    if (!WriteFile(hOut, msg, len, &written, NULL)) return 2;
    ExitProcess(0);
    return 0;
}
