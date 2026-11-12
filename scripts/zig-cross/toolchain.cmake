# Zig-based cross toolchain for aarch64-linux-musl.
# Used by scripts/m1-doom.mjs via POA_CMAKE_TOOLCHAIN_FILE.
# Paths are resolved relative to $POA_ROOT (exported by the dev shell / driver).
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR aarch64)
set(CMAKE_C_COMPILER "$ENV{POA_ROOT}/scripts/zig-cross/aarch64-linux-musl-cc")
set(CMAKE_CXX_COMPILER "$ENV{POA_ROOT}/scripts/zig-cross/aarch64-linux-musl-c++")
