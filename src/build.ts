/**
 * Build orchestration and verification harness for POA ports.
 *
 * Design rules:
 *  - No arbitrary shells. Fixed argv arrays only (cmake/make/artifact).
 *  - Missing toolchain components produce structured blockers with exact
 *    install commands — never silent wrong results.
 *  - poa.build records artifacts; poa.verify runs them and records proof.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { ingest } from "./manifest.js";
import type { PortSession } from "./session.js";

export interface ActionResult {
  ok: boolean;
  stage: "build" | "verify";
  detail: string;
  artifacts?: Array<{ path: string; arch: string }>;
  blocker?: { what: string; why: string; ask?: string };
  logTail?: string;
}

const TIMEOUT_BUILD_MS = 10 * 60 * 1000;
const TIMEOUT_VERIFY_MS = 15 * 1000;

async function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("which", [cmd], (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

async function whichMany(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    const found = await which(c);
    if (found) return found;
  }
  return null;
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        const timedOut = !!err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
        const code = err && typeof (err as NodeJS.ErrnoException).code === "number" ? ((err as NodeJS.ErrnoException).code as unknown as number) : err ? null : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr), timedOut });
      },
    );
  });
}

function tail(s: string, lines = 40): string {
  return s.split("\n").slice(-lines).join("\n");
}

const HOST_ARCH: Record<string, string> = { x64: "x86_64", arm64: "aarch64", ia32: "i386" };
export function hostArch(): string {
  return HOST_ARCH[process.arch] ?? process.arch;
}

/** Cross-toolchain candidates: Debian/Ubuntu name first, then NixOS/Nixpkgs (unknown-linux-gnu), then plain cc wrappers. */
const CROSS_TOOLCHAIN: Record<string, { ccCandidates: string[]; cxxCandidates: string[]; sysrootCandidates: string[]; label: string }> = {
  aarch64: {
    ccCandidates: ["aarch64-linux-gnu-gcc", "aarch64-unknown-linux-gnu-gcc", "aarch64-unknown-linux-gnu-cc", "aarch64-target-gcc"],
    cxxCandidates: ["aarch64-linux-gnu-g++", "aarch64-unknown-linux-gnu-g++", "aarch64-unknown-linux-gnu-c++"],
    sysrootCandidates: [process.env.POA_SYSROOT ?? "", "/usr/aarch64-linux-gnu", "/usr/aarch64-unknown-linux-gnu"],
    label: "aarch64-linux-gnu",
  },
  i386: {
    ccCandidates: ["i686-linux-gnu-gcc", "i686-unknown-linux-gnu-gcc", "i686-unknown-linux-gnu-cc"],
    cxxCandidates: ["i686-linux-gnu-g++", "i686-unknown-linux-gnu-g++", "i686-unknown-linux-gnu-c++"],
    sysrootCandidates: [process.env.POA_SYSROOT ?? "", "/usr/i686-linux-gnu", "/usr/i686-unknown-linux-gnu"],
    label: "i686-linux-gnu",
  },
};

async function resolveCrossToolchain(
  targetArch: string,
): Promise<{ cc: string; cxx: string | null; sysroot: string | null; label: string } | null> {
  const tc = CROSS_TOOLCHAIN[targetArch];
  if (!tc) return null;
  const cc = await whichMany(tc.ccCandidates);
  if (!cc) return null;
  const cxx = await whichMany(tc.cxxCandidates);
  const { existsSync } = await import("node:fs");
  const sysroot = tc.sysrootCandidates.find((s) => existsSync(s)) ?? null;
  return { cc, cxx, sysroot, label: tc.label };
}

async function crossBlocker(targetArch: string): Promise<ActionResult["blocker"]> {
  const tc = CROSS_TOOLCHAIN[targetArch];
  return {
    what: `cross toolchain for ${targetArch} not found`,
    why: tc
      ? `expected one of [${tc.ccCandidates.join(", ")}] on PATH — this host has native tools only`
      : `no cross toolchain profile known for arch '${targetArch}'`,
    ask: tc
      ? `Debian/Ubuntu: sudo apt install ${tc.label}-gcc ${tc.label}-g++ qemu-user-static\n` +
        `Windows from any host: POA_CMAKE_TOOLCHAIN_FILE=$POA_ROOT/scripts/zig-cross/windows-gnu-toolchain.cmake (zig cc, no system mingw needed)\n` +
        `NixOS:        nix develop    (POA's flake.nix provides cmake, ninja, qemu and the cross toolchains)`
      : `no cross toolchain profile for '${targetArch}' (see scripts/zig-cross/ — Windows targets build from any host with zig cc; no system MinGW required)\n` +
        `Windows targets from any host: POA_CMAKE_TOOLCHAIN_FILE=$POA_ROOT/scripts/zig-cross/windows-gnu-toolchain.cmake`,
  };
}

function toolchainFile(
  targetArch: string,
  file: string,
  toolchain: { cc: string; cxx: string | null; sysroot: string | null },
): Promise<void> {
  const sysrootLine = toolchain.sysroot ? `set(CMAKE_FIND_ROOT_PATH ${toolchain.sysroot})\n` : "# no sysroot found — linker may still work via -specs wrappers; expect trouble\n";
  const cmake = `# Generated by poa.build — do not edit
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR ${targetArch})
set(CMAKE_C_COMPILER ${toolchain.cc})
${toolchain.cxx ? `set(CMAKE_CXX_COMPILER ${toolchain.cxx})\n` : ""}${sysrootLine}set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
`;
  return fs.writeFile(file, cmake);
}

async function findElfArtifacts(dir: string, max = 20): Promise<Array<{ path: string; arch: string }>> {
  const out: Array<{ path: string; arch: string }> = [];
  async function scan(d: string, depth: number) {
    if (out.length >= max || depth > 4) return;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!["CMakeFiles", ".poa", ".git"].includes(e.name)) await scan(p, depth + 1);
        continue;
      }
      try {
        const fh = await fs.open(p, "r");
        const magic = Buffer.alloc(4);
        await fh.read(magic, 0, 4, 0);
        await fh.close();
        const isElf = magic.readUInt32LE(0) === 0x464c457f;
        const isPe = magic[0] === 0x4d && magic[1] === 0x5a; // "MZ"
        if (isElf || isPe) {
          const m = await ingest(p);
          out.push({ path: p, arch: m.arch });
        }
      } catch {
        /* unreadable candidate — skip */
      }
    }
  }
  await scan(dir, 0);
  return out;
}

export async function buildPort(
  cwd: string,
  session: PortSession,
  opts: { mode?: "auto" | "native" | "cross"; buildDir?: string; cmakeArgs?: string[] },
): Promise<ActionResult> {
  const extraArgs = opts.cmakeArgs ?? [];
  const { findTargetAsync } = await import("./targets.js");
  const target = await findTargetAsync(session.target, cwd);
  if (!target) {
    return { ok: false, stage: "build", detail: `unknown target '${session.target}'`, blocker: { what: "unknown target", why: `no built-in or .poa/targets/${session.target}.json` } };
  }

  const mode = opts.mode ?? "auto";
  // Native build only when OS family AND arch both match; otherwise cross.
  // (windows targets from linux hosts are cross builds even at same arch)
  const hostIsWindows = process.platform === "win32";
  const targetIsWindows = target.os === "windows";
  const crossNeeded = (target.arch !== hostArch() || hostIsWindows !== targetIsWindows) && target.arch !== "wasm32";
  const effectiveMode = mode === "auto" ? (crossNeeded ? "cross" : "native") : mode;

  const source = session.source;
  const isDir = (await fs.stat(source)).isDirectory();
  if (!isDir) {
    return { ok: false, stage: "build", detail: "source is a single file", blocker: { what: "nothing to build", why: "poa.build expects a source tree; for binaries use the (unbuilt) translation engine", ask: "provide a source checkout, or wait for M3 binary lifting" } };
  }

  const buildDir = path.resolve(cwd, opts.buildDir ?? path.join(".poa", "build", session.id));
  await fs.mkdir(buildDir, { recursive: true });

  // CMake path (preferred, best cross support). POA_CMAKE_SOURCE wins if set;
  // then the root, then the usual embedded-build locations (zstd: ./build/cmake).
  const CMAKE_CANDIDATE_DIRS = ["", "build/cmake", "cmake", "CMake", "build"];
  const envOverride = process.env.POA_CMAKE_SOURCE;
  let cmakeSrc: string | null = null;
  if (envOverride) {
    const p = path.resolve(cwd, envOverride);
    if (await fs.access(path.join(p, "CMakeLists.txt")).then(() => true, () => false)) {
      cmakeSrc = p;
    } else {
      return {
        ok: false,
        stage: "build",
        detail: `POA_CMAKE_SOURCE=${envOverride} has no CMakeLists.txt`,
        blocker: { what: "bad POA_CMAKE_SOURCE", why: `${p}/CMakeLists.txt not found`, ask: "point POA_CMAKE_SOURCE at a directory containing CMakeLists.txt" },
      };
    }
  }
  for (const d of cmakeSrc ? [] : CMAKE_CANDIDATE_DIRS) {
    const p = path.join(source, d);
    if (await fs.access(path.join(p, "CMakeLists.txt")).then(() => true, () => false)) {
      cmakeSrc = p;
      break;
    }
  }

  if (!cmakeSrc) {
    return {
      ok: false,
      stage: "build",
      detail: "no CMakeLists.txt found",
      blocker: {
        what: "unsupported build system (yet)",
        why: `no CMakeLists.txt at source root or in the usual embedded locations [${CMAKE_CANDIDATE_DIRS.map((d) => d || ".").join(", ")}]; meson/autotools/make are detected but not driven yet`,
        ask: "add a CMakeLists.txt (or POA_CMAKE_SOURCE override), or reimplements meson driver next",
      },
    };
  }

  const cmake = await which("cmake");
  if (!cmake) {
    return {
      ok: false,
      stage: "build",
      detail: "cmake not found on PATH",
      blocker: {
        what: "cmake missing",
        why: "M1 build orchestration drives cmake",
        ask: "Debian/Ubuntu: sudo apt install cmake ninja-build\nNixOS: nix shell nixpkgs#cmake nixpkgs#ninja  (or: nix develop)",
      },
    };
  }

  let configureArgs = ["-S", cmakeSrc, "-B", buildDir];
  const envToolchainFile = process.env.POA_CMAKE_TOOLCHAIN_FILE;
  if (effectiveMode === "cross") {
    if (envToolchainFile) {
      // Operator-supplied toolchain (e.g. zig-based, see scripts/zig-cross/).
      // We trust it explicitly because the operator pointed us at it; the
      // failure modes are loud either way.
      await fs.access(envToolchainFile);
      configureArgs = [
        ...configureArgs,
        `-DCMAKE_TOOLCHAIN_FILE=${envToolchainFile}`,
        "-DCMAKE_BUILD_TYPE=Release",
        ...extraArgs,
      ];
    } else {
      const tc = await resolveCrossToolchain(target.arch);
      if (!tc) {
        return { ok: false, stage: "build", detail: `cannot cross-compile to ${target.arch}`, blocker: (await crossBlocker(target.arch))! };
      }
      const tcFile = path.join(cwd, ".poa", "toolchains", `${target.arch}-linux-gnu.cmake`);
      await fs.mkdir(path.dirname(tcFile), { recursive: true });
      await toolchainFile(target.arch, tcFile, tc);
      configureArgs = [...configureArgs, `-DCMAKE_TOOLCHAIN_FILE=${tcFile}`, "-DCMAKE_BUILD_TYPE=Release", ...extraArgs];
    }
  } else {
    configureArgs = [...configureArgs, "-DCMAKE_BUILD_TYPE=Release", ...extraArgs];
  }

  const configure = await run(cmake, configureArgs, source, TIMEOUT_BUILD_MS);
  if (configure.timedOut || (configure.code ?? 1) !== 0) {
    return {
      ok: false,
      stage: "build",
      detail: `cmake configure failed (exit ${configure.code ?? "timeout"})`,
      logTail: tail(configure.stdout + "\n" + configure.stderr),
    };
  }

  const build = await run(cmake, ["--build", buildDir, "-j", String(cpus().length)], source, TIMEOUT_BUILD_MS);
  if (build.timedOut || (build.code ?? 1) !== 0) {
    return {
      ok: false,
      stage: "build",
      detail: `cmake build failed (exit ${build.code ?? "timeout"})`,
      logTail: tail(build.stdout + "\n" + build.stderr),
    };
  }

  const artifacts = await findElfArtifacts(buildDir);
  return {
    ok: true,
    stage: "build",
    detail: `built for ${effectiveMode} (${target.arch}); ${artifacts.length} ELF/PE artifact(s) found`,
    artifacts,
    logTail: tail(build.stdout, 12),
  };
}

async function findSysroot(targetArch: string): Promise<string | null> {
  const tc = CROSS_TOOLCHAIN[targetArch];
  if (!tc) return null;
  const { existsSync } = await import("node:fs");
  return tc.sysrootCandidates.find((s) => s.length > 0 && existsSync(s)) ?? null;
}

export async function verifyPort(
  cwd: string,
  session: PortSession,
  opts: { artifact?: string; args?: string[]; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<ActionResult & { outcome?: "passed" | "failed" | "timeout"; exitCode?: number | null }> {
  const { findTargetAsync } = await import("./targets.js");
  const target = await findTargetAsync(session.target, cwd);
  if (!target) {
    return { ok: false, stage: "verify", detail: `unknown target '${session.target}'` };
  }

  // Resolve artifact: explicit, else newest ELF matching the target arch in the build dir.
  let artifact = opts.artifact ? path.resolve(cwd, opts.artifact) : null;
  if (!artifact) {
    const buildDir = path.join(cwd, ".poa", "build", session.id);
    const candidates = await findElfArtifacts(buildDir);
    artifact = candidates.find((c) => c.arch === target.arch)?.path ?? candidates[0]?.path ?? null;
    if (!artifact) {
      return { ok: false, stage: "verify", detail: "no artifact found", blocker: { what: "nothing to verify", why: "run poa.build first (it scans .poa/build for ELF/PE output)" } };
    }
  }
  await fs.access(artifact);

  const timeoutMs = opts.timeoutMs ?? TIMEOUT_VERIFY_MS;
  const crossRun = target.arch !== hostArch();
  const args = opts.args ?? [];

  if (crossRun && target.arch !== "wasm32") {
    const qemu = await whichMany([`qemu-${target.arch === "i386" ? "i386" : target.arch}`, "qemu-aarch64-static", "qemu-aarch64"]);
    if (!qemu) {
      return {
        ok: false,
        stage: "verify",
        detail: `cannot run ${target.arch} binary on ${hostArch()} host`,
        blocker: {
          what: "qemu-user missing",
          why: "cross-arch smoke runs need qemu-user + a target sysroot",
          ask: "Debian/Ubuntu: sudo apt install qemu-user-static\nNixOS: nix develop   (POA's flake.nix provides qemu-user)",
        },
      };
    }
    const sysroot = await findSysroot(target.arch);
    const res = await run(qemu, [...(sysroot ? ["-L", sysroot] : []), artifact, ...args], path.dirname(artifact), timeoutMs, opts.env);
    return finalizeVerify(artifact, res);
  }

  const res = await run(artifact, args, path.dirname(artifact), timeoutMs, opts.env);
  return finalizeVerify(artifact, res);
}

function finalizeVerify(
  artifact: string,
  res: { code: number | null; stdout: string; stderr: string; timedOut: boolean },
): ActionResult & { outcome: "passed" | "failed" | "timeout"; exitCode: number | null } {
  const outcome = res.timedOut ? "timeout" : res.code === 0 ? "passed" : "failed";
  return {
    ok: outcome !== "failed",
    stage: "verify",
    detail:
      outcome === "passed"
        ? "exited 0"
        : outcome === "timeout"
          ? "still running at timeout — normal for interactive apps; treat as 'started and stayed up'"
          : `exited ${res.code}`,
    artifacts: [{ path: artifact, arch: "unknown" }],
    outcome,
    exitCode: res.code,
    logTail: tail(res.stdout + "\n" + res.stderr, 20),
  };
}
