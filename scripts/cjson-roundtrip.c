#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "cJSON.h"

static const char *sample = "{\"name\":\"POA\",\"version\":1,\"features\":[\"cross\",\"zig\"],\"active\":true,\"empty\":null}";

int main(void)
{
    cJSON *root = cJSON_Parse(sample);
    if (!root) {
        fprintf(stderr, "FAIL: parse error at %s\n", cJSON_GetErrorPtr());
        return 1;
    }
    cJSON *name = cJSON_GetObjectItem(root, "name");
    cJSON *version = cJSON_GetObjectItem(root, "version");
    cJSON *features = cJSON_GetObjectItem(root, "features");
    cJSON *active = cJSON_GetObjectItem(root, "active");
    cJSON *empty = cJSON_GetObjectItem(root, "empty");

    if (!cJSON_IsString(name) || strcmp(name->valuestring, "POA") != 0) return 2;
    if (!cJSON_IsNumber(version) || version->valuedouble != 1) return 3;
    if (!cJSON_IsArray(features) || cJSON_GetArraySize(features) != 2) return 4;
    if (!cJSON_IsTrue(active)) return 5;
    if (!cJSON_IsNull(empty)) return 6;

    char *printed = cJSON_Print(root);
    printf("cJSON OK: %s\n", printed);
    free(printed);
    cJSON_Delete(root);
    return 0;
}
