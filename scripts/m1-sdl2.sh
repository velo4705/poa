#!/bin/sh
# Build a minimal static SDL2 for aarch64-linux-musl with zig cc, install into
# .poa/sysroot-aarch64-musl/. Re-runnable; output is deleted first.
#
# Usage:  nix develop --command sh scripts/m1-sdl2.sh   (or: have zig+cmake+ninja on PATH)
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SDL2_VERSION="${SDL2_VERSION:-2.32.10}"
SDL2_SHA256="${SDL2_SHA256:-5f5993c530f084535c65a6879e9b26ad441169b3e25d789d83287040a9ca5165}"
WORK="$REPO_ROOT/.poa/sdl2-src"
SYSROOT="$REPO_ROOT/.poa/sysroot-aarch64-musl"

mkdir -p "$REPO_ROOT/.poa"
cd "$REPO_ROOT/.poa"
if [ ! -f SDL2.tar.gz ]; then
  echo "[m1-sdl2] downloading SDL2 ${SDL2_VERSION}"
  curl -sLo SDL2.tar.gz "https://github.com/libsdl-org/SDL/releases/download/release-${SDL2_VERSION}/SDL2-${SDL2_VERSION}.tar.gz"
fi
echo "$SDL2_SHA256  SDL2.tar.gz" | sha256sum -c -

rm -rf "$WORK" build-aarch64-musl
mkdir "$WORK"
tar xzf SDL2.tar.gz --strip-components=1 -C "$WORK"

export POA_ROOT="$REPO_ROOT"
cmake -S "$WORK" -B build-aarch64-musl -GNinja \
  -DCMAKE_TOOLCHAIN_FILE="$REPO_ROOT/scripts/zig-cross/toolchain.cmake" \
  -DCMAKE_INSTALL_PREFIX="$SYSROOT" \
  -DCMAKE_BUILD_TYPE=Release \
  -DSDL_SHARED=OFF -DSDL_STATIC=ON -DSDL_TEST=OFF -DSDL_BUILD_EXAMPLES=OFF \
  -DSDL_X11=OFF -DSDL_WAYLAND=OFF -DSDL_DIRECTFB=OFF -DSDL_KMSDRM=OFF \
  -DSDL_OFFSCREEN=OFF -DSDL_OPENGL=OFF -DSDL_OPENGLES=OFF \
  -DSDL_ALSA=OFF -DSDL_PULSEAUDIO=OFF -DSDL_OSS=OFF -DSDL_JACK=OFF \
  -DSDL_PIPEWIRE=OFF -DSDL_SNDIO=OFF -DSDL_HIDAPI=OFF
cmake --build build-aarch64-musl
cmake --install build-aarch64-musl
echo "[m1-sdl2] installed static SDL2 into $SYSROOT"
