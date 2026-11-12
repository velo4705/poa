# zig cc cross toolchain for x86_64-windows-gnu.
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR AMD64)
set(CMAKE_C_COMPILER "$ENV{POA_ROOT}/scripts/zig-cross/x86_64-windows-gnu-cc")
set(CMAKE_CXX_COMPILER "$ENV{POA_ROOT}/scripts/zig-cross/x86_64-windows-gnu-c++")
