#include <stdio.h>
#include <string.h>
#include "psa/crypto.h"

int main(void)
{
    const unsigned char msg[] = "hello Mbed TLS, cross-compiled for Windows";
    const size_t msglen = strlen((const char *)msg);
    unsigned char hash[32];
    size_t hash_len = 0;

    psa_status_t st = psa_crypto_init();
    if (st != PSA_SUCCESS) { fprintf(stderr, "psa_crypto_init failed: %d\n", st); return 1; }

    st = psa_hash_compute(PSA_ALG_SHA_256, msg, msglen, hash, sizeof hash, &hash_len);
    if (st != PSA_SUCCESS) { fprintf(stderr, "psa_hash_compute failed: %d\n", st); return 1; }

    printf("SHA-256(\"%s\")\n", msg);
    for (int i = 0; i < (int)hash_len; i++) printf("%02x", hash[i]);
    putchar('\n');

    const unsigned char expected[32] = {
        0x60,0xd2,0xde,0xb9,0x4b,0x1f,0x85,0xd9,0xf5,0x5c,0x7e,0xa1,0x14,0x76,0x34,0x4a,
        0xb4,0x14,0x60,0xfd,0x14,0x59,0x54,0x43,0x6c,0x61,0x7d,0xe6,0x86,0x42,0xc0,0x86
    };
    if (memcmp(hash, expected, 32) != 0) { fprintf(stderr, "SHA-256 mismatch\n"); return 2; }
    printf("PSA hash: PASS\n");
    return 0;
}
