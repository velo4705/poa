/**
 * Dependency scanning for port candidates.
 *
 *   ELF  → `readelf -d` (DT_NEEDED) — binutils, standard on Linux hosts
 *   PE   → `objdump -p` ("DLL Name:") — binutils, standard on Linux hosts
 *   WASM → manual import-section scan (no external tools needed)
 *   Mach-O / managed bytecode → explicit "unsupported on this host" blocker,
 *           never a silent guess
 *
 * No tool → structured blocker naming the missing binary. No hallucinated
 * dependency lists.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface DependencyScan {
  input: string;
  format: string;
  dependencies: string[];
  /** true when every needed dependency looks locally satisfiable (advisory only) */
  confidence: number;
  notes: string[];
}

function run(cmd: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: process.cwd(), timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = !error ? 0 : typeof error.code === "number" ? error.code : null;
      resolve({ code, out: String(stdout), err: String(stderr) });
    });
  });
}

async function which(cmd: string): Promise<boolean> {
  const r = await run("which", [cmd]);
  return r.code === 0;
}

async function scanElf(file: string): Promise<DependencyScan> {
  if (!(await which("readelf"))) {
    throw new Error("readelf not found on PATH (binutils required)");
  }
  const { out } = await run("readelf", ["-d", file]);
  const deps = [...out.matchAll(/Shared library: \[(.*?)\]/g)].map((m) => m[1]!);
  return {
    input: file,
    format: "ELF (dynamic)",
    dependencies: [...new Set(deps)].sort(),
    confidence: 0.95,
    notes: deps.length === 0 ? ["no DT_NEEDED entries — static binary?"] : [],
  };
}

async function scanPe(file: string): Promise<DependencyScan> {
  if (!(await which("objdump"))) {
    throw new Error("objdump not found on PATH (binutils required)");
  }
  const { out } = await run("objdump", ["-p", file]);
  const deps = [...out.matchAll(/DLL Name: (.+)/g)].map((m) => m[1]!.trim());
  return {
    input: file,
    format: "PE (import table)",
    dependencies: [...new Set(deps)].sort(),
    confidence: 0.9,
    notes: deps.length === 0 ? ["no DLL Name imports found — static .exe, or .NET metadata (not an import table)"] : [],
  };
}

/** WASM section ids we care about: 2 = import. */
const WASM_SECTION_IMPORT = 2;
const WASM_EXTERNAL_KINDS = { 0: "func", 1: "table", 2: "mem", 3: "global" } as const;

function readVarUInt(buf: Buffer, off: number): { value: number; next: number } {
  let result = 0, shift = 0;
  for (;;) {
    const byte = buf[off++]!;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new Error("varuint overflow");
  }
  return { value: result >>> 0, next: off };
}
function readVarInt(buf: Buffer, off: number): { value: number; next: number } {
  // Sufficient for small LEB128 values we only use for section lengths/counts.
  return readVarUInt(buf, off);
}
function readString(buf: Buffer, off: number): { value: string; next: number } {
  const { value: len, next } = readVarUInt(buf, off);
  return { value: buf.toString("utf8", next, next + len), next: next + len };
}

function skipTableDescriptor(buf: Buffer, off: number): number {
  // reftype byte (0x70 func, 0x6f extern, or sleb for heap types) — then limits
  let cur = off;
  const reftype = buf[cur]!;
  if (reftype >= 0x40 && (reftype & 0x80) === 0) {
    cur += 1; // single-byte const heap type
  } else {
    cur = readVarInt(buf, cur).next; // sleb-encoded heap type
  }
  return skipLimits(buf, cur);
}
function skipLimits(buf: Buffer, off: number): number {
  const { value: flags, next } = readVarUInt(buf, off);
  let cur = next;
  if (flags & 0x1) cur = readVarUInt(buf, cur).next; // max present
  if (flags & 0x4) cur = readVarUInt(buf, cur).next; // shared (threads)
  if (flags & 0x8) cur = readVarUInt(buf, cur).next; // memory64 (reserved encoding)
  return cur;
}
function skipMemDescriptor(buf: Buffer, off: number): number {
  return skipLimits(buf, off);
}
function skipGlobalDescriptor(buf: Buffer, off: number): number {
  let cur = off;
  const valtype = buf[cur]!;
  if (valtype & 0x80) {
    cur = readVarInt(buf, cur).next; // ref type (sleb)
  } else {
    cur += 1;
  }
  return cur + 1; // mutability byte
}

export function scanWasmImports(buf: Buffer): Array<{ module: string; name: string; kind: string }> {
  const imports: Array<{ module: string; name: string; kind: string }> = [];
  if (buf.length < 8) throw new Error("truncated WASM module");
  if (buf.toString("latin1", 0, 4) !== "\0asm") throw new Error("not a WASM module");
  let off = 8; // magic + version
  while (off < buf.length) {
    const sectionId = buf[off]!;
    const { value: size, next: sizeOff } = readVarUInt(buf, off + 1);
    const sectionStart = sizeOff;
    const sectionEnd = sectionStart + size;
    if (sectionId !== WASM_SECTION_IMPORT) {
      off = sectionEnd;
      continue;
    }
    let cur = sectionStart;
    const { value: count, next: countOff } = readVarUInt(buf, cur);
    cur = countOff;
    for (let i = 0; i < count && cur < sectionEnd; i++) {
      const mod = readString(buf, cur); cur = mod.next;
      const name = readString(buf, cur); cur = name.next;
      const kindByte = buf[cur]!;
      const kind = WASM_EXTERNAL_KINDS[kindByte as 0 | 1 | 2 | 3] ?? `kind${kindByte}`;
      cur += 1;
      if (kindByte === 0) cur = readVarUInt(buf, cur).next;        // func: typeidx
      else if (kindByte === 1) cur = skipTableDescriptor(buf, cur); // table
      else if (kindByte === 2) cur = skipMemDescriptor(buf, cur);   // memory
      else if (kindByte === 3) cur = skipGlobalDescriptor(buf, cur);// global
      imports.push({ module: mod.value, name: name.value, kind });
    }
    off = sectionEnd;
  }
  return imports;
}

export async function scanDependencies(inputPath: string): Promise<DependencyScan> {
  const abs = path.resolve(inputPath);
  const stat = await fs.stat(abs);
  if (stat.isDirectory()) {
    return {
      input: abs,
      format: "directory tree",
      dependencies: [],
      confidence: 0,
      notes: ["dependency closure for source trees = detect build system + read its manifest (see poa.detect_buildsystem); not a byte-scan"],
    };
  }

  const fd = await fs.open(abs, "r");
  const head = Buffer.alloc(Math.min(stat.size, 64));
  await fd.read(head, 0, head.length, 0);
  await fd.close();

  if (head.readUInt32LE(0) === 0x464c457f) return scanElf(abs);
  if (head.toString("latin1", 0, 2) === "MZ") return scanPe(abs);
  if (head.toString("latin1", 0, 4) === "\0asm") {
    const buf = await fs.readFile(abs);
    try {
      const imports = scanWasmImports(buf);
      const modules = [...new Set(imports.map((i) => i.module))].sort();
      return {
        input: abs,
        format: "WebAssembly module",
        dependencies: modules,
        confidence: 0.95,
        notes: [`${imports.length} import(s) total; modules: ${modules.join(", ") || "(none — pure module)"}`],
      };
    } catch (err) {
      return {
        input: abs,
        format: "WebAssembly module",
        dependencies: [],
        confidence: 0.3,
        notes: [`import scan incomplete: ${(err as Error).message}`],
      };
    }
  }
  // Mach-O detection
  const m = head.readUInt32LE(0);
  if (m === 0xfeedface || m === 0xfeedfacf || m === 0xcefaedfe || m === 0xcefaedff) {
    throw new Error("Mach-O dependency scan needs otool (macOS) — unsupported on this host; no faked output");
  }
  return {
    input: abs,
    format: `unrecognised (magic 0x${head.readUInt32LE(0).toString(16)})`,
    dependencies: [],
    confidence: 0,
    notes: ["no dependency scanner for this format yet"],
  };
}
