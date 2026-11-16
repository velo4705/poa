#include <stdio.h>
#include <string.h>
#include "zip.h"

static const char *sample_files[2] = { "a.txt", "b.txt" };

int main(void)
{
    zip_t *z = NULL;
    zip_source_t *s1 = NULL, *s2 = NULL;

    z = zip_open("test-poa.zip", ZIP_CREATE | ZIP_TRUNCATE, NULL);
    if (!z) {
        fprintf(stderr, "FAIL: zip_open\n");
        return 2;
    }

    s1 = zip_source_buffer_create("hello", 5, 0, NULL);
    s2 = zip_source_buffer_create("world", 5, 0, NULL);
    if (!s1 || !s2) {
        fprintf(stderr, "FAIL: zip_source_buffer_create\n");
        return 3;
    }

    if (zip_file_add(z, sample_files[0], s1, 0) < 0) {
        fprintf(stderr, "FAIL: zip_file_add 0\n");
        return 4;
    }
    if (zip_file_add(z, sample_files[1], s2, 0) < 0) {
        fprintf(stderr, "FAIL: zip_file_add 1\n");
        return 5;
    }
    if (zip_close(z) < 0) {
        fprintf(stderr, "FAIL: zip_close\n");
        return 6;
    }

    printf("libzip roundtrip: PASS\n");
    return 0;
}
