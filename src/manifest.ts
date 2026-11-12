/**
 * Ingestion layer: classify an input file and build a Port Manifest.
 *
 * This does real byte-level detection (ELF, PE, Mach-O, WASM, ZIP containers)
 * and reports confidence honestly. What it does NOT do yet: API-surface
 * extraction, dependency closure analysis, or decompilation. Those report
 * themselves as explicit unknowns, never as silent guesses.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export type InputKind =
  | "source"
  | "binary-native"
  | "binary-managed"
  | "firmware"
  | "assets"
  | "unknown";

export interface PortManifest {
  input: string;
  kind: InputKind;
  /** Human-readable format detail, e.g. "ELF64 LSB x86-64". */
  format: string;
  /** Normalised arch when known: x86_64 | aarch64 | arm | i386 | riscv64 | wasm32 | unknown */
  arch: string;
  bits: 32 | 64 | null;
  endianness: "le" | "be" | null;
  /** OS hint derived from format headers when available (e.g. Linux ABI). */
  platformHint: string | null;
  sizeBytes: number;
  /** 0.0–1.0 confidence in `kind`/`arch` overall. */
  confidence: number;
  /** What we could not determine. Surfaced in the discrepancy map. */
  unknowns: string[];
}

const EM: Record<number, string> = {
  3: "i386",
  40: "arm",
  62: "x86_64",
  183: "aarch64",
  243: "riscv64",
};

function u16(buf: Buffer, off: number, le: boolean): number | null {
  if (off + 2 > buf.length) return null;
  return le ? buf.readUInt16LE(off) : buf.readUInt16BE(off);
}

function u32(buf: Buffer, off: number, le: boolean): number | null {
  if (off + 4 > buf.length) return null;
  return le ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
}

function detectElf(buf: Buffer, sizeBytes: number, input: string): PortManifest {
  const bits = buf[4] === 2 ? 64 : buf[4] === 1 ? 32 : null;
  const le = buf[5] !== 2; // 1 = LSB, 2 = MSB; default LE if truncated
  const osAbi = buf[7];
  const machine = u16(buf, 18, le);
  const arch = machine !== null ? EM[machine] ?? `em_${machine}` : "unknown";
  const osAbiName =
    osAbi === 3 ? "linux" : osAbi === 0 ? "sysv" : osAbi === 9 ? "freebsd" : `osabi_${osAbi}`;
  return {
    input,
    kind: "binary-native",
    format: `ELF${bits ?? "?"}${le ? " LSB" : " MSB"} ${arch}`,
    arch,
    bits,
    endianness: le ? "le" : "be",
    platformHint: osAbiName,
    sizeBytes,
    confidence: machine !== undefined && machine !== null ? 0.95 : 0.6,
    unknowns: ["required-API surface (needs disassembly or import analysis)", "dependency closure"],
  };
}

function detectPe(buf: Buffer, sizeBytes: number, input: string): PortManifest {
  const eLfanew = u32(buf, 0x3c, true);
  const peOff = eLfanew ?? -1;
  const hasPe =
    peOff >= 0 && peOff + 6 <= buf.length && buf.toString("latin1", peOff, peOff + 4) === "PE\0\0";
  let arch = "unknown";
  let bits: 32 | 64 | null = null;
  if (hasPe) {
    const machine = u16(buf, peOff + 4, true);
    switch (machine) {
      case 0x8664:
        arch = "x86_64";
        bits = 64;
        break;
      case 0xaa64:
        arch = "aarch64";
        bits = 64;
        break;
      case 0x14c:
        arch = "i386";
        bits = 32;
        break;
      case 0x1c0:
      case 0x1c4:
        arch = "arm";
        bits = 32;
        break;
      default:
        arch = `0x${machine?.toString(16) ?? "?"}`;
    }
  }
  // .NET assemblies carry the "BSJB" metadata signature somewhere in the file.
  const isManaged = buf.includes(Buffer.from("BSJB", "latin1"));
  return {
    input,
    kind: isManaged ? "binary-managed" : "binary-native",
    format: isManaged ? "PE/.NET assembly" : `PE32${bits === 64 ? "+ 64-bit" : ""} ${arch}`,
    arch,
    bits,
    endianness: "le",
    platformHint: "windows",
    sizeBytes,
    confidence: hasPe ? 0.9 : 0.5,
    unknowns: [
      "required-API surface (needs import table analysis)",
      "dependency closure (DLLs)",
      ...(isManaged ? ["target framework version"] : []),
    ],
  };
}

function detectMachO(buf: Buffer, sizeBytes: number, input: string): PortManifest {
  const magicLE = buf.readUInt32LE(0);
  // Mach-O magics (stored little-endian on disk for LE hosts)
  const is64 = magicLE === 0xfeedfacf || magicLE === 0xcefaedfe;
  const is32 = magicLE === 0xfeedface || magicLE === 0xcefaedfe - 0x1000000;
  const cpuType = buf.length >= 8 ? buf.readUInt32LE(4) : 0;
  const isArm64 = cpuType === 0x0100000c;
  const arch = isArm64 ? "aarch64" : cpuType === 0x00000007 ? "i386" : cpuType === 0x01000007 ? "x86_64" : "unknown";
  return {
    input,
    kind: "binary-native",
    format: `Mach-O ${is64 || isArm64 ? "64-bit" : is32 ? "32-bit" : "?"} ${arch}`,
    arch,
    bits: is64 || isArm64 ? 64 : 32,
    endianness: "le",
    platformHint: "macos/ios",
    sizeBytes,
    confidence: 0.9,
    unknowns: ["required-API surface (needs load-command analysis)", "dependency closure (dylibs)"],
  };
}

function detectWasm(_buf: Buffer, sizeBytes: number, input: string): PortManifest {
  return {
    input,
    kind: "binary-managed",
    format: "WebAssembly module",
    arch: "wasm32",
    bits: 32,
    endianness: "le",
    platformHint: "wasm",
    sizeBytes,
    confidence: 0.99,
    unknowns: ["imported host functions (needs custom-section + import scan)"],
  };
}

function detectZip(buf: Buffer, sizeBytes: number, input: string): PortManifest {
  const head = buf.toString("latin1", 0, Math.min(buf.length, 4096));
  const looksApk = head.includes("AndroidManifest.xml") || head.includes("META-INF");
  return {
    input,
    kind: "assets",
    format: looksApk ? "ZIP container (APK/JAR-class)" : "ZIP container",
    arch: "unknown",
    bits: null,
    endianness: null,
    platformHint: looksApk ? "android/jvm" : null,
    sizeBytes,
    confidence: 0.7,
    unknowns: ["container entry inventory", "which entries are native code vs assets"],
  };
}

function looksLikeSourceDir(name: string): boolean {
  return [".git", "src", "package.json", "CMakeLists.txt", "Cargo.toml", "go.mod"].some((n) =>
    name.includes(n),
  );
}

export async function ingest(inputPath: string): Promise<PortManifest> {
  const abs = path.resolve(inputPath);
  const stat = await fs.stat(abs);

  if (stat.isDirectory()) {
    return {
      input: abs,
      kind: looksLikeSourceDir(abs) ? "source" : "unknown",
      format: "directory tree",
      arch: "unknown",
      bits: null,
      endianness: null,
      platformHint: null,
      sizeBytes: 0,
      confidence: looksLikeSourceDir(abs) ? 0.7 : 0.3,
      unknowns: ["build system detection", "dependency closure"],
    };
  }

  // 1 MiB is plenty for header detection (incl. BSJB scan).
  const fd = await fs.open(abs, "r");
  try {
    const head = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
    await fd.read(head, 0, head.length, 0);

    if (head.length >= 4 && head.readUInt32LE(0) === 0x464c457f) return detectElf(head, stat.size, abs);
    if (head.length >= 2 && head.toString("latin1", 0, 2) === "MZ") return detectPe(head, stat.size, abs);
    if (head.length >= 4) {
      const m = head.readUInt32LE(0);
      if (m === 0xfeedface || m === 0xfeedfacf || m === 0xcefaedfe || m === 0xcefaedff) {
        return detectMachO(head, stat.size, abs);
      }
      if (head.toString("latin1", 0, 4) === "\0asm") return detectWasm(head, stat.size, abs);
      if (head.toString("latin1", 0, 2) === "PK") return detectZip(head, stat.size, abs);
    }
    return {
      input: abs,
      kind: "firmware",
      format: "unrecognised (raw image / firmware / data)",
      arch: "unknown",
      bits: null,
      endianness: null,
      platformHint: null,
      sizeBytes: stat.size,
      confidence: 0.2,
      unknowns: ["everything — no known magic bytes matched"],
    };
  } finally {
    await fd.close();
  }
}
