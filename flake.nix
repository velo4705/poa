{
  description = "POA (Port Anything) dev shell — M1 toolchain: zig cross-compiler, cmake, ninja, qemu-user, node";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in {
        devShells.default = pkgs.mkShell {
          # Everything here is in the binary cache; cross compilation itself is
          # done by zig (single prebuilt binary), NOT by pkgsCross (source builds).
          packages = [
            pkgs.nodejs_24
            pkgs.cmake
            pkgs.ninja
            pkgs.qemu        # qemu-aarch64 for poa.verify
            pkgs.zig         # zig cc cross-compiler (aarch64-linux-musl, static)
            # windres (x86_64-w64-mingw32-windres) for .rc resource files —
            # zig cannot build them, but binutils wrapper is small and cached.
            pkgs.pkgsCross.mingwW64.buildPackages.binutils
            # wine64 (minimal) — verify Windows PE binaries end-to-end on Linux
            pkgs.wine64Packages.minimal
          ];

          shellHook = ''
            export POA_ROOT="$PWD"
            export POA_CMAKE_TOOLCHAIN_FILE="$PWD/scripts/zig-cross/toolchain.cmake"
            export CMAKE_PREFIX_PATH="$PWD/.poa/sysroot-aarch64-musl:''${CMAKE_PREFIX_PATH:-}"
            export PKG_CONFIG_LIBDIR="$PWD/.poa/sysroot-aarch64-musl/lib/pkgconfig"
            echo "POA dev shell: node, cmake, ninja, qemu-aarch64, zig cc (static aarch64-linux-musl)."
            echo "One-time SDL2 build for cross ports:  sh scripts/m1-sdl2.sh"
            echo "Run the M1 gate:                     nix develop --command node scripts/m1-doom.mjs"
          '';
        };
      });
}
