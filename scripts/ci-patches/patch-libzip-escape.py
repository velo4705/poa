#!/usr/bin/env python3
"""CI patch: libzip's GenerateCommandTable.cmake picks the shell/cmd.exe
escaping strategy off `if(NOT WIN32)`. Cross-compiling to Windows from Linux
sets WIN32=TRUE, so unescaped ';' reaches /bin/sh — each path runs as its own
command. Fix: always escape. Applied to a fresh clone, never to git HEAD.
Usage: patch-libzip-escape.py <libzip-root>
"""
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
p = root / "cmake" / "GenerateCommandTable.cmake"
s = p.read_text()
before = s
s = s.replace(
    '''  if(NOT WIN32)
    string(REPLACE ";" "\\\\;" SOURCES_ABS_ESCAPED "${SOURCES_ABSOLUTE}")
  else()
    set(SOURCES_ABS_ESCAPED "${SOURCES_ABSOLUTE}")
  endif()''',
    '''  # always escape — we invoke this via /bin/sh (Linux cross-compiling
  # to Windows) regardless of host/target
  string(REPLACE ";" "\\\\;" SOURCES_ABS_ESCAPED "${SOURCES_ABSOLUTE}")''')
if s == before:
    print("note: GenerateCommandTable.cmake did not match the known block; leaving as-is", file=sys.stderr)
    sys.exit(1)
p.write_text(s)
print("patched", p)
