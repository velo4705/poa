/**
 * poa.go_buildinfo — read the Go build information embedded in a Go binary.
 *
 * Every Go binary since 1.18 carries a `runtime.buildInfo` blob with the
 * module path, the full dependency graph (module, version, h1 hash), and
 * the build settings (GOOS, GOARCH, CGO_ENABLED, tags, -trimpath, ldflags).
 * It survives stripping and -trimpath. This tool simply runs
 * `go version -m` and parses the result into structured JSON.
 *
 * It does NOT decompile anything. It tells you exactly which source and
 * dependency versions the binary was built from — the key evidence an
 * auditor needs before choosing a strategy.
 *
 * poa.verify_embedded_assets — prove that a directory of reference files
 * (e.g. a freshly built `frontend/dist`) appears byte-identically inside a
 * target binary. Used to show a Wails/go-embed frontend survived into the
 * shipped artifact, and to recover those exact bytes from the binary.
 *
 * Matching is byte-exact; a CRLF-normalized fallback is tried for files
 * that contain LF, because Windows toolchains often emit CRLF inside a
 * binary that a Linux-built reference file does not contain. Reports are
 * per-file: offset, size, sha256, and match type. Non-matches are reported
 * as not-found — never silently re-labelled.
 *
 * Neither tool claims to recover source code from machine code.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number | null; out: string; err: string }> {
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

export interface GoBuildInfo {
  ok: boolean;
  goVersion?: string;
  module?: string;
  moduleVersion?: string;
  moduleHash?: string;
  deps?: Array<{ path: string; version: string; hash: string }>;
  build?: Record<string, string>;
  raw?: string;
  blocker?: { what: string; why: string; ask?: string };
}

/** Parse `go version -m` output into structured JSON. */
export async function goBuildInfo(input: string): Promise<GoBuildInfo> {
  const abs = path.resolve(input);
  const exists = await fs.access(abs).then(() => true, () => false);
  if (!exists) return { ok: false, blocker: { what: "no input file", why: `path not found: ${abs}` } };

  const go = await whichOnPath("go");
  if (!go) {
    return {
      ok: false,
      blocker: {
        what: "go toolchain not on PATH",
        why: "`go version -m` is required to read embedded buildinfo",
        ask: "Install Go (https://go.dev/dl/) or run inside the POA dev shell.",
      },
    };
  }

  const r = await run(go, ["version", "-m", abs], 30_000);
  const raw = (r.out + "\n" + r.err).trim();
  if (r.code !== 0 || /not a Go executable|go: cannot find/i.test(raw)) {
    return {
      ok: false,
      blocker: {
        what: "no embedded Go buildinfo",
        why: raw.split("\n")[0] ?? `go version -m exited with code ${r.code}`,
        ask: "The binary is not a Go binary (or was built with a very old toolchain). Check poa.inspect_input / poa.scan_dependencies instead.",
      },
      raw: raw.slice(0, 2000),
    };
  }

  const info: GoBuildInfo = { ok: true, deps: [], build: {}, raw };
  const lines = r.out.split("\n");
  // First line: "<file>: go1.25.12"
  const head = lines[0] ?? "";
  const m = head.match(/:\s*(go\S+)\s*$/);
  if (m?.[1]) info.goVersion = m[1];

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const f = line.split("\t").map((s) => s.trim()).filter((s) => s.length > 0);
    const kind = f[0];
    if (kind === "path") { /* main module path == module */ }
    else if (kind === "mod") {
      if (f[1] !== undefined) info.module = f[1];
      if (f[2] !== undefined) info.moduleVersion = f[2];
      if (f[3] !== undefined) info.moduleHash = f[3];
    } else if (kind === "dep") {
      info.deps?.push({ path: f[1] ?? "", version: f[2] ?? "", hash: f[3] ?? "" });
    } else if (kind === "build") {
      const kv = (f.slice(1).join("\t")).trim();
      const eq = kv.indexOf("=");
      if (eq === -1) continue;
      const key = kv.slice(0, eq).replace(/^-+/, "");
      const value = kv.slice(eq + 1);
      info.build![key] = value;
    }
  }
  if (!info.goVersion) {
    return {
      ok: false,
      blocker: { what: "unparseable buildinfo", why: "could not find a go<version> header", ask: "Report this binary — the output format may be newer than this parser." },
      raw: raw.slice(0, 2000),
    };
  }
  return info;
}

export type AssetMatch = "exact" | "crlf" | "eol-normalized" | "not-found" | "empty";
export interface AssetEntry {
  file: string;
  size: number;
  sha256: string;
  match: AssetMatch;
  offset?: number;
}
export interface VerifyAssetsReport {
  ok: boolean;
  input: string;
  inputSha256: string;
  referenceDir: string;
  total: number;
  foundByteIdentical: number;
  foundCrlfNormalized: number;
  foundEolNormalized: number;
  notFound: number;
  bytesMatched: number;
  assets: AssetEntry[];
  blocker?: { what: string; why: string; ask?: string };
}

/** Return a copy of `src` with every occurrence of `byte` removed. */
function removeByte(src: Buffer, byte: number): Buffer {
  let count = 0;
  for (let i = 0; i < src.length; i++) if (src[i] === byte) count++;
  if (count === 0) return src;
  const dst = Buffer.allocUnsafe(src.length - count);
  let w = 0;
  for (let i = 0; i < src.length; i++) {
    const b = src[i]!;
    if (b !== byte) dst[w++] = b;
  }
  return dst;
}

function trimTrailingByte(src: Buffer, byte: number): Buffer {
  let end = src.length;
  while (end > 0 && src[end - 1] === byte) end--;
  return end === src.length ? src : src.subarray(0, end);
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== ".git") yield* walkFiles(p); }
    else if (e.isFile()) yield p;
  }
}

export async function verifyEmbeddedAssets(opts: { input: string; referenceDir: string; output?: string }): Promise<VerifyAssetsReport & { written?: string }> {
  const input = path.resolve(opts.input);
  const ref = path.resolve(opts.referenceDir);
  const iStat = await fs.stat(input).catch(() => null);
  if (!iStat?.isFile()) {
    return {
      ok: false, input, inputSha256: "", referenceDir: ref, total: 0,
      foundByteIdentical: 0, foundCrlfNormalized: 0, foundEolNormalized: 0, notFound: 0, bytesMatched: 0, assets: [],
      blocker: { what: "no input file", why: `path not found: ${input}` },
    };
  }
  const rStat = await fs.stat(ref).catch(() => null);
  if (!rStat?.isDirectory()) {
    return {
      ok: false, input, inputSha256: "", referenceDir: ref, total: 0,
      foundByteIdentical: 0, foundCrlfNormalized: 0, foundEolNormalized: 0, notFound: 0, bytesMatched: 0, assets: [],
      blocker: { what: "no reference directory", why: `not a directory: ${ref}` },
    };
  }

  const buf = await fs.readFile(input);
  const inputSha256 = createHash("sha256").update(buf).digest("hex");
  const bufNoCR = removeByte(buf, 0x0d);
  const assets: AssetEntry[] = [];

  for await (const f of walkFiles(ref)) {
    const bytes = await fs.readFile(f);
    const rel = path.relative(ref, f);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length === 0) {
      assets.push({ file: rel, size: 0, sha256, match: "empty", offset: 0 });
      continue;
    }
    let offset = buf.indexOf(bytes);
    if (offset !== -1) {
      assets.push({ file: rel, size: bytes.length, sha256, match: "exact", offset });
      continue;
    }
    // CRLF fallback: a Windows build may embed LF files as CRLF. 0x0A never
    // appears inside a valid UTF-8 multi-byte sequence, so a byte-level
    // substitution is safe.
    if (bytes.includes(0x0a)) {
      const crlf = Buffer.allocUnsafe(bytes.length + bytes.filter((b) => b === 0x0a).length);
      let w = 0;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0x0a) { crlf[w++] = 0x0d; crlf[w++] = 0x0a; } else { crlf[w++] = bytes[i]!; }
      }
      offset = buf.indexOf(crlf);
      if (offset !== -1) {
        assets.push({ file: rel, size: crlf.length, sha256, match: "crlf", offset });
        continue;
      }
    }
    // EOL-normalized fallback: strip ALL CR bytes from both sides and try
    // again with trailing LF trimmed from the needle. Covers artifacts that
    // mix CRLF/CRCRLF/LF (common in Windows-built embedded assets). The
    // reported offset is relative to the CR-stripped view of the input, not
    // the original file — documented, and still useful for carving.
    if (bytes.includes(0x0a) || bytes.includes(0x0d)) {
      const needle = trimTrailingByte(removeByte(bytes, 0x0d), 0x0a);
      if (needle.length > 0 && bufNoCR.indexOf(needle) !== -1) {
        assets.push({ file: rel, size: bytes.length, sha256, match: "eol-normalized" });
        continue;
      }
    }
    assets.push({ file: rel, size: bytes.length, sha256, match: "not-found" });
  }

  const exact = assets.filter((a) => a.match === "exact");
  const nf = assets.filter((a) => a.match === "not-found");
  const report: VerifyAssetsReport = {
    ok: true,
    input,
    inputSha256,
    referenceDir: ref,
    total: assets.length,
    foundByteIdentical: exact.length,
    foundCrlfNormalized: assets.filter((a) => a.match === "crlf").length,
    foundEolNormalized: assets.filter((a) => a.match === "eol-normalized").length,
    notFound: nf.length,
    bytesMatched: assets.filter((a) => a.match !== "not-found" && a.match !== "empty").reduce((a, b) => a + b.size, 0),
    assets,
  };

  if (opts.output) {
    const out = path.resolve(opts.output);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(report, null, 2));
    return { ...report, written: out };
  }
  return report;
}

/**
 * poa.extract_dotnet — recover a .NET assembly's IL as compilable C# source
 * and map its Windows-only dependencies to target-platform substitutes.
 *
 * This is source recovery, not a binary lift: .NET IL carries full type and
 * member metadata, so a decompiler can reconstruct faithful C#. The output is
 * a dependency map for the agent, NOT a runnable Linux port. BAML (compiled
 * WPF XAML) and native P/Invoke targets still need a real port/rewrite.
 */
export interface DotnetPInvoke {
  library: string;
  count: number;
  functions: string[];
}

export interface DependencyMapping {
  windows: string;
  linuxTarget: string;
  note: string;
}

export interface DotnetExtraction {
  ok: boolean;
  input: string;
  outputDir: string;
  tool: string;
  sourceFiles: number;
  sourceLines: number;
  pinvokes: DotnetPInvoke[];
  uiFramework: "WPF" | "WinForms" | "unknown";
  dependencyMap: DependencyMapping[];
  notes: string[];
  blocker?: { what: string; why: string; ask?: string };
}

export async function extractDotnet(opts: { input: string; outputDir: string }): Promise<DotnetExtraction> {
  const input = path.resolve(opts.input);
  const out = path.resolve(opts.outputDir);
  const empty: DotnetExtraction = {
    ok: false, input, outputDir: out, tool: "", sourceFiles: 0, sourceLines: 0,
    pinvokes: [], uiFramework: "unknown", dependencyMap: [], notes: [],
  };
  const exists = await fs.access(input).then(() => true, () => false);
  if (!exists) return { ...empty, blocker: { what: "no input file", why: `path not found: ${input}` } };
  const tool = await whichOnPath("ilspycmd");
  if (!tool) {
    return { ...empty, blocker: {
      what: "ilspycmd not on PATH",
      why: "IL decompilation is required to recover C# source from a managed assembly",
      ask: "Install ilspycmd (dotnet tool) or run inside a shell that provides it.",
    } };
  }

  await fs.mkdir(out, { recursive: true });
  const r = await run(tool, ["-p", "--nested-directories", "-o", out, input], 180_000);
  if (r.code !== 0) {
    return { ...empty, tool, blocker: {
      what: "ilspycmd failed",
      why: `ilspycmd exited with code ${r.code}`,
    }, notes: [(r.out + "\n" + r.err).slice(-1000)] };
  }

  let sourceFiles = 0;
  let sourceLines = 0;
  let uiFramework: DotnetExtraction["uiFramework"] = "unknown";
  const byLib = new Map<string, Set<string>>();
  for await (const f of walkFiles(out)) {
    if (!f.endsWith(".cs")) continue;
    sourceFiles++;
    const text = await fs.readFile(f, "utf8");
    sourceLines += text.split("\n").length;
    if (/PresentationFramework|System\.Windows\.Controls|System\.Windows\.Media/.test(text)) uiFramework = "WPF";
    else if (uiFramework === "unknown" && /System\.Windows\.Forms/.test(text)) uiFramework = "WinForms";
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const dm = lines[i]!.match(/DllImport\(\s*"([^"]+)"/);
      if (!dm) continue;
      const lib = dm[1]!;
      const next = (lines[i + 1] ?? "") + (lines[i + 2] ?? "");
      const fn = next.match(/extern\s+[\w<>\[\],.]+\s+([A-Za-z_]\w*)\s*\(/);
      if (!byLib.has(lib)) byLib.set(lib, new Set());
      byLib.get(lib)!.add(fn?.[1] ?? "(unknown)");
    }
  }

  const pinvokes = [...byLib.entries()]
    .map(([library, fns]) => ({ library, functions: [...fns].sort(), count: fns.size }))
    .sort((a, b) => b.count - a.count);

  const dependencyMap: DependencyMapping[] = [
    ...pinvokes.map((p) => ({
      windows: p.library,
      linuxTarget: /kernel32|user32|gdi32|advapi32|shell32|ole32|oleaut32|imm32|uxTheme/i.test(p.library)
        ? "per-binary native Linux adapter implementing the used functions"
        : /^EMP_|^eIC\.dll/i.test(p.library)
          ? "Linux native engine port (C/C++ source required)"
          : "audit each imported function; provide a Linux-native equivalent",
      note: `${p.count} imported function(s)`,
    })),
    ...(uiFramework === "WPF" ? [{
      windows: "WPF / PresentationFramework (BAML views)",
      linuxTarget: "Avalonia AXAML rewrite",
      note: "compiled BAML cannot run on Linux; XAML must be decompiled and retargeted manually",
    }] : []),
    ...(uiFramework === "WinForms" ? [{
      windows: "System.Windows.Forms",
      linuxTarget: "Avalonia or GTK rewrite",
      note: "WinForms has no Linux implementation",
    }] : []),
    {
      windows: "Windows registry / COM / WDF drivers",
      linuxTarget: "XDG config / D-Bus / PipeWire+uhid",
      note: "platform services need explicit adapters, never a binary shim",
    },
  ];

  return {
    ok: true, input, outputDir: out, tool, sourceFiles, sourceLines, pinvokes,
    uiFramework, dependencyMap,
    notes: [
      "IL was recovered as C# source; this is NOT machine-code decompilation.",
      "BAML views are compiled XAML and need a separate XAML decompilation + retargeting step.",
      "Native P/Invoke targets are machine code; POA cannot recover their source from IL.",
      "This tool produces source + a dependency map, NOT a runnable Linux binary.",
    ],
  };
}
