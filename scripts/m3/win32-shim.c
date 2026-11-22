/*
 * Per-binary host shim: the 198-byte Windows PE function lifted in M3 calls
 * exactly three kernel32 imports. This file implements them natively on Linux
 * and maps the PE's flat address space, so the recompiled lifted code runs.
 * This is NOT Wine — no generic compatibility layer, just three functions.
 *
 * Hardcoded values are derived from this specific PE (see the driver):
 *   .text at file offset 0x400, RVA 0x1000 → lift address 0x400, delta RVA-0xC00
 *   IAT slots (guest) 0x1488/0x1490/0x1498 hold hint/name RVAs 0x20a8/0x20b6/0x20c6
 *   Remill x86-64 State offsets: RAX 2216, RCX 2248, RDX 2264, R8 2344, R9 2360, RSP 2312
 *   These were verified against the generated IR GEPs and by execution under Linux.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>

#define BASE 0x10000000UL
#define GUEST_STACK 0x300000UL
#define RAX_OFF 2216
#define RCX_OFF 2248
#define RDX_OFF 2264
#define R8_OFF 2344
#define R9_OFF 2360
#define RSP_OFF 2312
#define IAT_EXIT 0x1488UL
#define IAT_GETSTD 0x1490UL
#define IAT_WRITE 0x1498UL
#define RVA_DELTA 0xC00UL

extern void *sub_400(void *state, uint64_t pc, void *mem);

/* Remill intrinsics: guest addresses are the flat space used at lift time. */
uint8_t  __remill_read_memory_8(void *m, uint64_t a)  { return *(uint8_t *)(BASE + a); }
uint32_t __remill_read_memory_32(void *m, uint64_t a) { return *(uint32_t *)(BASE + a); }
uint64_t __remill_read_memory_64(void *m, uint64_t a) { return *(uint64_t *)(BASE + a); }
void *__remill_write_memory_8(void *m, uint64_t a, uint8_t v)  { *(uint8_t *)(BASE + a) = v; return m; }
void *__remill_write_memory_32(void *m, uint64_t a, uint32_t v) { *(uint32_t *)(BASE + a) = v; return m; }
void *__remill_write_memory_64(void *m, uint64_t a, uint64_t v) { *(uint64_t *)(BASE + a) = v; return m; }
uint8_t __remill_undefined_8(void) { return 0; }
int __remill_flag_computation_zero(int a, ...) { return a; }
int __remill_flag_computation_sign(int a, ...) { return a; }
int __remill_flag_computation_carry(int a, ...) { return 0; }
int __remill_flag_computation_overflow(int a, ...) { return 0; }
int __remill_compare_eq(int a, ...) { return a; }
int __remill_compare_neq(int a, ...) { return a; }
void *__remill_function_return(void *s, uint64_t pc, void *m) { (void)pc; return m; }
void *__remill_error(void *s, uint64_t pc, void *m) { (void)pc; (void)m; (void)s; abort(); }

/* The three Win32 imports, implemented directly on Linux. */
static void *WINAPI_GetStdHandle(uint32_t which) { (void)which; return (void *)1; }
static int WINAPI_WriteFile(void *h, uintptr_t buf, uint32_t len, uintptr_t written, void *ov) {
    (void)h; (void)ov;
    ssize_t n = write(1, (const void *)(uintptr_t)(BASE + buf), len);
    if (written) *(uint32_t *)(uintptr_t)(BASE + written) = (uint32_t)n;
    return n == (ssize_t)len;
}
static void WINAPI_ExitProcess(uint32_t code) { exit((int)code); }

/* Import thunks the lifter emitted as calls into separate functions:
 * reproduce `jmp [IAT]` and honour Remill's "return value in RAX" convention. */
static void *call_iat(uint64_t slot, void *state) {
    void *fn = *(void **)(BASE + slot);
    uint64_t a1 = *(uint64_t *)((char *)state + RCX_OFF), a2 = *(uint64_t *)((char *)state + RDX_OFF);
    uint64_t a3 = *(uint64_t *)((char *)state + R8_OFF),  a4 = *(uint64_t *)((char *)state + R9_OFF);
    void *ret = ((void *(*)(uint64_t, uint64_t, uint64_t, uint64_t))fn)(a1, a2, a3, a4);
    *(uint64_t *)((char *)state + RAX_OFF) = (uint64_t)(uintptr_t)ret;
    return ret;
}
void *sub_470(void *s, uint64_t pc, void *m) { (void)pc; (void)m; return call_iat(IAT_EXIT, s); }
void *sub_480(void *s, uint64_t pc, void *m) { (void)pc; (void)m; return call_iat(IAT_GETSTD, s); }
void *sub_490(void *s, uint64_t pc, void *m) { (void)pc; (void)m; return call_iat(IAT_WRITE, s); }

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    FILE *f = fopen(argv[1], "rb");
    if (!f) return 2;
    fseek(f, 0, SEEK_END); long size = ftell(f); fseek(f, 0, SEEK_SET);
    void *image = mmap((void *)BASE, 0x1000000, PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
    if (image == MAP_FAILED) return 2;
    if (fread(image, 1, size, f) != (size_t)size) return 2;
    fclose(f);
    /* Rebuild the flat address space as Remill saw it (guest = RVA - 0xC00). */
    unsigned char *raw = malloc(size);
    memcpy(raw, image, size);
    memset(image, 0, 0x1000000);
    memcpy(image, raw, 0x400);
    uint32_t pe = *(uint32_t *)(raw + 0x3c);
    uint16_t nsect = *(uint16_t *)(raw + pe + 6);
    uint32_t optsize = *(uint16_t *)(raw + pe + 20);
    unsigned char *sect = raw + pe + 24 + optsize;
    for (unsigned i = 0; i < nsect; i++, sect += 40) {
        uint32_t rva = *(uint32_t *)(sect + 12), rawsize = *(uint32_t *)(sect + 16);
        uint32_t rawoff = *(uint32_t *)(sect + 20);
        if (rva >= RVA_DELTA && rawsize) memcpy(image + (rva - RVA_DELTA), raw + rawoff, rawsize);
    }
    /* Rebase image-base pointers and patch IAT hint/name RVAs. */
    for (long i = 0; i + 8 <= 0xB0000; i += 8) {
        uint64_t v = *(uint64_t *)(image + i);
        if (v >= 0x140000000ULL && v < 0x140B00000ULL)
            *(uint64_t *)(image + i) = v - 0x140000000ULL - RVA_DELTA;
        else if (v == 0x20a8UL) *(uint64_t *)(image + i) = (uint64_t)(uintptr_t)&WINAPI_ExitProcess;
        else if (v == 0x20b6UL) *(uint64_t *)(image + i) = (uint64_t)(uintptr_t)&WINAPI_GetStdHandle;
        else if (v == 0x20c6UL) *(uint64_t *)(image + i) = (uint64_t)(uintptr_t)&WINAPI_WriteFile;
    }
    static _Alignas(16) unsigned char state[3504];
    memset(state, 0, sizeof(state));
    *(uint64_t *)(state + RSP_OFF) = GUEST_STACK;
    *(uint64_t *)(BASE + GUEST_STACK) = 0xDEADBEEFUL; /* fake return address */
    sub_400(state, 0x400, image);
    return 3; /* WinMain returned instead of ExitProcess */
}
