# Contributing to POA

POA is an open MCP server for porting software you have the right to port.
We keep the surface small, the claims honest, and the diffs reviewable.

## Ground rules (not negotiable)

1. **No quality-loss claims that aren't earned.** If a change silently drops
   fidelity — deletes tests, ignores failures, papers over a build error —
   it gets rejected on sight. Declared degradation via `poa.declare_degradation`
   is fine; hidden loss is not.
2. **No claims beyond evidence.** A green CI check is a green check. A
   `wine64` run is a smoke run, not a gameplay test. Say what you checked.
3. **Right to port it.** Only contribute code or drivers for software you
   own, that is open source, or that you are licensed to redistribute.
   DRM/anti-cheat/console-SDK porting is out of scope, period.
4. **GPL-licensed code is fine**, because provenance is declared as
   `open-source` by the POA pipeline. Relicensing it is still your problem.
5. **No secrets, no internal infrastructure** in the repo or its history.
   `.poa/` is git-ignored — do not check in sessions, logs, or build output
   from local runs.

## Building and running

```sh
npm install
npm run build             # tsc → dist/
node scripts/smoke.mjs    # end-to-end stdio smoke test (initialize + tools/list + tools/call)
```

Useful entry points:

- `scripts/m1-doom.mjs` — M1 proof: Chocolate DOOM → aarch64 via POA's own tools.
- `scripts/m2-compat-*.mjs` — M2 corpus drivers (zstd, sqlite, libarchive, cmark,
  mbedtls, cjson, jansson, libzip).
- `scripts/m2-mbedtls.mjs` — Mbed TLS corpus driver.
- `scripts/zig-cross/` — zig cc wrappers and the cmake toolchain file used for
  cross-compile builds from Linux.
- `scripts/zig-cross/windows-gnu-toolchain.cmake` — what the CI ubuntu lanes use.
- `scripts/ci-patches/` — inline patches applied to CI clones. File an upstream
  PR if you can; merging the workaround upstream is always better than carrying it.
- `shim/poa_shim.c` + `shim/poa_shim_test.c` — the C compliance shim (build + run).
- `flake.nix` — dev shell: nodejs, cmake, ninja, qemu-user, zig cc (all binary-cached).
- `docs/` — architecture, roadmap, usage, shim matrix, port reports.

On Linux with Nix:

```sh
nix develop --command npm run build
nix develop --command node scripts/smoke.mjs
```

## What must stay green

- `npm run build` clean
- `node scripts/smoke.mjs` green
- `shim/poa_shim_test.c` builds and runs green
- Every CI lane in `.github/workflows/ci.yml` green (not only the one you touched)

## Corpus drivers

The corpus projects are zstd, SQLite, libarchive, cmark, Mbed TLS, cJSON,
jansson, libzip. Their drivers (`scripts/m2-*.mjs`) call POA's own MCP tools
— no source editing, no local forks. Fixing a driver means fixing the lane,
not a hidden makefile.

## Pull requests

- Keep diffs small. If you touch >300 lines, explain why in the PR body.
- Show the evidence you ran. "CI will tell me" is not evidence.
- If you can't run a lane locally, mark it `needs-platform: <linux|windows|macos>`
  and say so explicitly in the PR body.
- Corpus lane changes do not merge without the corresponding CI lane passing.

## Code style

Match the file you're in. TypeScript strict, no implicit `any`. C files are
plain C11. No `.d.ts` stubs, no type-only declarations outside `src/..`.

## Reporting bugs

Please include: platform, your exact commands, the full tool output around
the failure (attach the output, don't paraphrase it), and whether
`npm run build` was clean.

## Enforcement

The maintainers reserve the right to close PRs that drift from the legal
scope or the quality contract, even if they are otherwise good code.
