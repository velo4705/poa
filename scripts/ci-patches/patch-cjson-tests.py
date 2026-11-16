#!/usr/bin/env python3
"""CI patch: cJSON tests/CMakeLists.txt links unity_setup.c only when
CMAKE_C_COMPILER_ID == MSVC. With every other compiler the Unity runner
references setUp/tearDown with no definition — link failure.
Fix: link it unconditionally. Applied to a fresh clone, never to git HEAD.
Usage: patch-cjson-tests.py <cjson-root>
"""
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
p = root / "tests" / "CMakeLists.txt"
s = p.read_text()
before = s
s = s.replace(
    '''    if("${CMAKE_C_COMPILER_ID}" STREQUAL "MSVC")
            target_sources(${unity_test} PRIVATE unity_setup.c)
        endif()''',
    '''    target_sources(${unity_test} PRIVATE unity_setup.c)''')
s = s.replace(
    '''            if("${CMAKE_C_COMPILER_ID}" STREQUAL "MSVC")
                target_sources(${cjson_utils_test} PRIVATE unity_setup.c)
            endif()''',
    '''            target_sources(${cjson_utils_test} PRIVATE unity_setup.c)''')
if s == before:
    print("note: cJSON tests/CMakeLists.txt did not match the known MSVC-only blocks; leaving as-is", file=sys.stderr)
    sys.exit(1)
p.write_text(s)
print("patched", p)
