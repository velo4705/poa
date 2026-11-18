void _start(void) {
    const char *msg = "Hello from the M3 spike\n";
    /* write(1, msg, 23) */
    long n = 23;
    __asm__ volatile (
        "syscall"
        : "=a"(n) : "a"(1), "D"(1), "S"(msg), "d"(23) : "rcx", "r11", "memory");
    (void)n;
    /* exit(0) */
    __asm__ volatile (
        "mov $60, %%rax\n\t"
        "xor %%rdi, %%rdi\n\t"
        "syscall" ::: "rax", "rdi", "rcx", "r11", "memory");
    __builtin_unreachable();
}
