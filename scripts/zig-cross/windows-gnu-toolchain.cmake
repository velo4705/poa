set(CMAKE_SYSTEM_NAME Windows)

# Cross-compiling to Windows from Linux: force WIN32 off inside scripts which
# use it to choose a command-line escaping strategy (e.g. libzip GenerateCommandTable.cmake).
# Native Windows hosts unaffected.
set(WIN32 FALSE)

set(CMAKE_SYSTEM_PROCESSOR AMD64)
set(CMAKE_C_COMPILER "$ENV{POA_ROOT}/scripts/zig-cross/x86_64-windows-gnu-cc")
set(CMAKE_CXX_COMPILER "$ENV{POA_ROOT}/scripts/zig-cross/x86_64-windows-gnu-c++")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
if(DEFINED ENV{POA_WINDRES})
  set(CMAKE_RC_COMPILER "$ENV{POA_WINDRES}" CACHE FILEPATH "RC compiler" FORCE)
else()
  set(CMAKE_RC_COMPILER ${CMAKE_CURRENT_LIST_DIR}/x86_64-windows-gnu-windres CACHE FILEPATH "RC compiler" FORCE)
endif()
