# zig cc cross toolchain for x86_64-windows-gnu.
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR AMD64)
set(CMAKE_C_COMPILER "$ENV{POA_ROOT}/scripts/zig-cross/x86_64-windows-gnu-cc")
set(CMAKE_CXX_COMPILER "$ENV{POA_ROOT}/scripts/zig-cross/x86_64-windows-gnu-c++")
# .rc resource files: zig cannot build them, so we use mingw-w64's windres
# driven by zig as its preprocessor (scripts/zig-cross/x86_64-windows-gnu-windres).
# It's in the dev shell; POA_WINDRES env can override.
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
if(DEFINED ENV{POA_WINDRES})
  set(CMAKE_RC_COMPILER "$ENV{POA_WINDRES}" CACHE FILEPATH "RC compiler" FORCE)
else()
  set(CMAKE_RC_COMPILER ${CMAKE_CURRENT_LIST_DIR}/x86_64-windows-gnu-windres CACHE FILEPATH "RC compiler" FORCE)
endif()
