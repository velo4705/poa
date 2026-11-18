/**
 * poa.lift — static retranslation via Remill.
 *
 * Lifts a native binary to LLVM IR bitcode. Does NOT claim the lifted IR
 * compiles to a working port for your target — that requires linking
 * against a Linux-runtime shim whose API surface matches what the binary
 * imports, which is a multi-thousand-line project per runtime (sub, ldr,
 * COM, DirectX, …). A "lift succeeds" result tells you Remill was able
 * to decode the instructions, full stop.
 *
 * Inputs:
 *   input    — absolute path to a PE / ELF / Mach-O binary
 *   output   — output file path (default: <input>.bc beside the input)
 *   arch     — override detected arch (amd64 | x86_64 | aarch64 | aarch32 | i386)
 *   range    — optional byte range [start, end] (file offsets). Default: whole file.
 *
 * Returns:
 *   { ok: true,  irPath, bitcodePath, stats, logTail }    — success
 *   { ok: false, blocker: { what, why, ask? }, logTail }  — structured failure
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

function run(cmd: string, args: string[], timeoutMs = 90_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = !error ? 0 : typeof error.code === "number" ? error.code : null;
      resolve({ code, out: String(stdout), err: String(stderr) });
    });
  });
}

async function whichOnPath(cmd: string): Promise<string | null> {
  const r = await run("which", [cmd]);
  const line = r.out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return r.code === 0 && line ? line : null;
}

/** Locate a Remill lifter binary. POA_REMILL points at one, otherwise PATH, /nix/store as a fallback. */
export async function findRemill(): Promise<string | null> {
  if (process.env.POA_REMILL && (await fs.access(process.env.POA_REMILL).then(() => true, () => false))) {
    return process.env.POA_REMILL;
  }
  // PATH search first
  const onPath = await whichOnPath("remill-lift");
  if (onPath) return onPath;
  // nix store fallback — any amd64 lifter present in the store
  try {
    const entries = await fs.readdir("/nix/store");
    for (const e of entries) {
      if (!e.includes("remill") || !e.endsWith("")) continue;
      const candidate = path.join("/nix/store", e, "bin");
      const binEntries = await fs.readdir(candidate).catch(() => []);
      for (const b of binEntries) {
        const m = b.match(/^remill-lift-(\d+)$/);
        if (m) return path.join(candidate, b);
      }
    }
  } catch { /* ignore */ }
  return null;
}

/** Cheap arch detection from PE/ELF/Mach-O magic bytes. Returns canonical Remill name. */
async function detectArch(file: string): Promise<{ arch: string; bytes: Buffer }> {
  const head = Buffer.alloc(512);
  const fd = await fs.open(file, "r");
  await fd.read(head, 0, 512, 0);
  await fd.close();

  if (head[0] === 0x4d && head[1] === 0x5a) {
    /* PE — CommonObjFileHeader Machine field at offset 0x3c (PE header offset) */
    const lfaNew = head.readUInt32LE(0x3c);
    const peH = Buffer.alloc(6);
    const fd2 = await fs.open(file, "r");
    await fd2.read(peH, 0, 6, lfaNew);
    await fd2.close();
    if (peH[0] === 0x50 && peH[1] === 0x45) { /* "PE\0\0" */
      const m = peH.readUInt16LE(4);
      if (m === 0x014c) return { arch: "i386", bytes: head };
      if (m === 0x8664) return { arch: "amd64", bytes: head };
      if (m === 0xaa64) return { arch: "aarch64", bytes: head };
    }
    return { arch: "amd64", bytes: head }; // best guess for PE
  }
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
    /* ELF e_machine at offset 18, 2 bytes */
    const m = head.readUInt16LE(18);
    if (m === 0x03) return { arch: "i386", bytes: head };
    if (m === 0x3e) return { arch: "amd64", bytes: head };
    if (m === 0xb7) return { arch: "aarch64", bytes: head };
    if (m === 0x28) return { arch: "aarch32", bytes: head };
  }
  if (head[0] === 0xcf && head[1] === 0xfa && head[2] === 0xed && head[3] === 0xfe) {
    /* Mach-O 64-bit, cputype at 4 bytes */
    const m = head.readUInt32LE(4);
    if (m === 0x01000007) return { arch: "amd64", bytes: head };
    if (m === 0x0100000c) return { arch: "aarch64", bytes: head };
  }
  return { arch: "amd64", bytes: head }; // fallback — amd64 covers most
}

export interface LiftInput {
  input: string;
  output?: string;
  arch?: "amd64" | "x86_64" | "i386" | "aarch64" | "aarch32";
  os?: "windows" | "linux" | "macos" | "solaris";
  range?: [number, number];
}

export interface LiftResult {
  ok: boolean;
  irPath?: string;
  logTail?: string;
  blocker?: { what: string; why: string; ask?: string };
  stats?: { arch: string; os: string; bytesLifted: number };
}

export async function liftBinary(opts: LiftInput): Promise<LiftResult> {
  const input = path.resolve(opts.input);
  const exists = await fs.access(input).then(() => true, () => false);
  if (!exists) return { ok: false, blocker: { what: "no input file", why: `path not found: ${input}` } };
  const stat = await fs.stat(input);
  if (!stat.isFile()) return { ok: false, blocker: { what: "input is not a file", why: input } };
  const remill = await findRemill();
  if (!remill) {
    return {
      ok: false,
      blocker: {
        what: "remill lifter not found",
        why: "Build it from https://github.com/lifting-bits/remill (LLVM 17+ required) and put `remill-lift` on PATH, or set POA_REMILL.",
        ask: "Build Remill or skip this path; use poa.build for source ports instead.",
      },
    };
  }

  const detected = await detectArch(input);
  const arch = opts.arch ?? detected.arch;
  const os = opts.os ?? (path.extname(input).toLowerCase() === ".exe" ? "windows" : "linux");
  const outDir = path.dirname(opts.output ?? path.join(path.dirname(input), `${path.basename(input)}.lifted`));
  await fs.mkdir(outDir, { recursive: true });
  const out = opts.output ?? path.join(outDir, `${path.basename(input)}.bc`);

  const [start, end] = opts.range ?? [0, stat.size];
  const fd = await fs.open(input, "r");
  const buf = Buffer.alloc(end - start);
  await fd.read(buf, 0, end - start, start);
  await fd.close();
  const hex = buf.toString("hex");
  // remill only accepts -bytes inline; for inputs > a few KB argv overflows.
  // Use -flagfile to pass everything through a file.
  const flagPath = path.join(outDir, "remill-flags.txt");
  await fs.writeFile(flagPath,
    [
      `-arch=${arch}`,
      `-os=${os}`,
      `-address=${start}`,
      `-bytes=${hex}`,
      `-bc_out=${out}`,
    ].join('\n') + '\n');

  const r = await run(remill, ["-flagfile", flagPath], 180_000);

  if (r.code !== 0) {
    return {
      ok: false,
      blocker: {
        what: "remill failed to lift",
        why: `remill-lift exited with code ${r.code}. See logTail for the error.`,
      },
      logTail: (r.out + "\n" + r.err).slice(-2000),
    };
  }

  return {
    ok: true,
    irPath: out,
    logTail: (r.out + "\n" + r.err).slice(-1000),
    stats: { arch, os, bytesLifted: buf.length },
  };
}

/** Compile a lifted .ll / .bc to an ELF/PE for the target arch via zig cc. */
export interface RecompileInput {
  irPath: string;
  targetArch: "aarch64" | "x86_64" | "arm" | "i386" | "riscv64";
  targetOs?: "linux" | "windows" | "macos";
  output?: string;
}

export interface RecompileResult {
  ok: boolean;
  output?: string;
  logTail?: string;
  blocker?: { what: string; why: string; ask?: string };
}

export async function recompileFromIr(opts: RecompileInput): Promise<RecompileResult> {
  const irPath = path.resolve(opts.irPath);
  const exists = await fs.access(irPath).then(() => true, () => false);
  if (!exists) return { ok: false, blocker: { what: "IR file not found", why: irPath } };
  const zig = await whichOnPath("zig");
  if (!zig) return { ok: false, blocker: { what: "zig not on PATH", why: "need zig cc to compile lifted bitcode to a machine object", ask: "Install zig (https://ziglang.org/download/)" } };
  const targetOs = opts.targetOs ?? "linux";
  const zigTriple = opts.targetArch === "x86_64" ? (targetOs === "windows" ? "x86_64-windows-gnu" : "x86_64-linux-gnu")
    : opts.targetArch === "i386" ? "x86-linux-gnu"
    : opts.targetArch === "arm" ? "arm-linux-gnueabihf"
    : opts.targetArch === "riscv64" ? "riscv64-linux-gnu"
    : "aarch64-linux-musl";
  const outDir = path.dirname(opts.output ?? path.join(path.dirname(irPath), "recompiled"));
  await fs.mkdir(outDir, { recursive: true });
  const out = opts.output ?? path.join(outDir, `${path.basename(irPath, path.extname(irPath))}.o`);
  const r = await run(zig, ["cc", "-target", zigTriple, "-c", irPath, "-o", out]);
  if (r.code !== 0) {
    return {
      ok: false,
      blocker: { what: "zig cc failed", why: `zig cc exited with code ${r.code}` },
      logTail: (r.out + "\n" + r.err).slice(-2000),
    };
  }
  return { ok: true, output: out, logTail: (r.out + "\n" + r.err).slice(-1000) };
}
