/**
 * poa.assess_portability — the honesty ladder behind the README promise:
 *
 *   ❌ Lift a binary to a different platform by magic — POA refuses to pretend
 *
 * Walks a single binary from the most achievable outcome to the hardest blocker
 * and returns a verdict at each rung, with measured evidence:
 *
 *   1. same platform        — the artifact already is the port (LOSSLESS)
 *   2. source-derived       — pinned source rebuild (NEAR-LOSSLESS)
 *   3. lift to IR/object    — real artifact, but NOT a runnable foreign binary
 *   4. freestanding         — no OS imports → lift+recompile can be a real port
 *   5. OS ABI boundary      — imports from the source OS → no Linux ABI shim
 *   6. runtime coupling     — WPF/WebView2/kernel drivers → impossible; source only
 *
 * The tool never claims a "magic lift". It states what POA can actually build,
 * where the ladder stops, and what would be required to go further.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ingest } from "./manifest.js";
import { scanDependencies } from "./scan.js";
import { goBuildInfo } from "./extract.js";
import { findRemill } from "./lift.js";

export type RungStatus = "possible" | "partial" | "conditional" | "blocked" | "impossible" | "not-applicable";

export interface LadderRung {
  rung: number;
  id: string;
  title: string;
  status: RungStatus;
  claim: string;
  evidence: string[];
  requirement?: string;
}

export interface PortabilityVerdict {
  /** POA never claims magic; this field makes the refusal machine-readable. */
  magicLift: "refused";
  canProduceRunnablePort: boolean;
  bestHonestOutcome: string;
  stopAtRung: number;
  blockers: string[];
  recommendedChain: string[];
}

export interface PortabilityAssessment {
  ok: boolean;
  input: string;
  sha256: string;
  target: { os: string; arch: string };
  ladder: LadderRung[];
  verdict: PortabilityVerdict;
  evidence: {
    format: string;
    arch: string;
    platformHint: string | null;
    sourceOs: string | null;
    dependencies: string[];
    dependencyScanNote: string | null;
    runtimeMarkers: string[];
    goModule: string | null;
    goDeps: number;
    remillAvailable: boolean;
  };
  blocker?: { what: string; why: string; ask?: string };
}

function canonArch(a: string | null | undefined): string {
  if (!a) return "unknown";
  const x = a.toLowerCase();
  if (x === "amd64" || x === "x86-64" || x === "x86_64") return "x86_64";
  if (x === "i386" || x === "i686" || x === "x86") return "i386";
  if (x === "arm64" || x === "aarch64") return "aarch64";
  return x;
}

/** Markers of Windows-only runtimes. Byte scan of the whole file, case-insensitive. */
const RUNTIME_MARKERS: Array<{ id: string; needle: string; reason: string }> = [
  { id: "wpf", needle: "PresentationFramework", reason: "WPF has no Linux implementation — the UI must be rewritten (e.g. Avalonia)" },
  { id: "winforms", needle: "System.Windows.Forms", reason: "WinForms requires the Windows desktop stack" },
  { id: "webview2", needle: "ICoreWebView2", reason: "WebView2 is a Windows COM control; no binary-level mapping to WebKitGTK" },
  { id: "kernel-driver", needle: "WdfCoInstaller", reason: "kernel-mode/WDF drivers have no Linux binary counterpart" },
  { id: "msi", needle: "Windows Installer", reason: "MSI payload is Windows installer plumbing, not portable code" },
];

function detectMarkers(buf: Buffer): Array<{ id: string; reason: string }> {
  const hay = buf.toString("latin1").toLowerCase();
  const found: Array<{ id: string; reason: string }> = [];
  for (const m of RUNTIME_MARKERS) {
    if (hay.includes(m.needle.toLowerCase()) && !found.some((f) => f.id === m.id)) {
      found.push({ id: m.id, reason: m.reason });
    }
  }
  return found;
}

export async function assessPortability(opts: { input: string; targetOs?: string; targetArch?: string }): Promise<PortabilityAssessment> {
  const abs = path.resolve(opts.input);
  const targetOs = (opts.targetOs ?? "linux").toLowerCase();
  const targetArch = canonArch(opts.targetArch ?? "x86_64");

  const exists = await fs.access(abs).then(() => true, () => false);
  if (!exists) {
    return {
      ok: false, input: abs, sha256: "", target: { os: targetOs, arch: targetArch },
      ladder: [], verdict: { magicLift: "refused", canProduceRunnablePort: false, bestHonestOutcome: "none", stopAtRung: 0, blockers: ["input not found"], recommendedChain: [] },
      evidence: { format: "", arch: "", platformHint: null, sourceOs: null, dependencies: [], dependencyScanNote: null, runtimeMarkers: [], goModule: null, goDeps: 0, remillAvailable: false },
      blocker: { what: "no input file", why: `path not found: ${abs}` },
    };
  }

  const [manifest, depsResult, go, remill, bytes] = await Promise.all([
    ingest(abs).catch(() => null),
    scanDependencies(abs).then((r) => ({ deps: r.dependencies, note: null as string | null })).catch((e) => ({ deps: [] as string[], note: (e as Error).message })),
    goBuildInfo(abs).catch(() => ({ ok: false } as const)),
    findRemill().catch(() => null),
    fs.readFile(abs),
  ]);

  const sha256 = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  const sourceOs: string | null =
    manifest?.platformHint === "windows" ? "windows"
      : manifest?.platformHint === "linux" || manifest?.platformHint === "sysv" ? "linux"
        : manifest?.platformHint ?? null;
  const sourceArch = canonArch(manifest?.arch);
  const archMatch = sourceArch === targetArch || sourceArch === "unknown";
  const osMatch = sourceOs === targetOs;
  const samePlatform = !!(manifest && osMatch && archMatch && manifest.kind !== "assets");
  const markers = detectMarkers(bytes);
  const goOk = "ok" in go && go.ok === true;
  const goModule = goOk && "module" in go ? go.module ?? null : null;
  const goDeps = goOk && "deps" in go && Array.isArray(go.deps) ? go.deps.length : 0;
  const hasImports = depsResult.deps.length > 0;
  const isManaged = !!manifest && manifest.kind === "binary-managed";
  const supportedByRemill = ["x86_64", "i386", "aarch64", "arm"].includes(sourceArch);
  const firmwareTarget = /firmware|bare-?metal|none|uefi|freestanding/i.test(targetOs);

  const ladder: LadderRung[] = [];
  const ev = (s: string) => s;

  // Rung 1 — same platform
  ladder.push({
    rung: 1,
    id: "same-platform",
    title: "Already on the target platform",
    status: samePlatform ? "possible" : "not-applicable",
    claim: samePlatform
      ? `The artifact is already a ${targetOs}/${targetArch} binary — POA repackages it, no translation. Fidelity: LOSSLESS.`
      : `Source is ${sourceOs ?? "unknown"}/${sourceArch}; target is ${targetOs}/${targetArch} — no direct run.`,
    evidence: [ev(`manifest: ${manifest?.format ?? "unknown"} (${manifest?.kind ?? "unknown"})`), ev(`source OS: ${sourceOs ?? "unknown"}, arch: ${sourceArch}`)],
  });

  // Rung 2 — source-derived
  ladder.push({
    rung: 2,
    id: "source-derived",
    title: "Build from pinned source",
    status: goOk ? "possible" : "conditional",
    claim: goOk
      ? `Go buildinfo recovered (module ${goModule ?? "?"}, ${goDeps} deps) — rebuild from the exact dependency set. Fidelity: NEAR-LOSSLESS if the source tree is available.`
      : "If rights-holder source exists, rebuild from source; POA cannot recover non-Go source from machine code. Use poa.go_buildinfo to check Go binaries.",
    evidence: goOk
      ? [`go buildinfo: ${goModule ?? "?"} (${goDeps} deps)`]
      : [`embedded source metadata: ${goOk ? "present" : "not a Go binary or no buildinfo"}`],
    requirement: goOk ? "source tree matching the pinned module/deps" : "source tree from the rights holder",
  });

  // Rung 3 — lift to IR/object
  ladder.push({
    rung: 3,
    id: "ir-object",
    title: "Lift to IR and compile an object file",
    status: remill && supportedByRemill && manifest?.kind === "binary-native" ? "partial" : "blocked",
    claim: remill && supportedByRemill && manifest?.kind === "binary-native"
      ? "POA can emit LLVM bitcode and an ELF/PE relocatable object. That is an ANALYSIS artifact — not a runnable port: no OS ABI, no startup code, no linked runtime."
      : remill ? `Remill found but source arch ${sourceArch} is not lift-supported, or input is managed/not native.` : "Remill not found: install it or set POA_REMILL.",
    evidence: [ev(`remill: ${remill ? "available" : "missing"}`), ev(`source arch: ${sourceArch}`), ev(`kind: ${manifest?.kind ?? "unknown"}`)],
    requirement: "a host-side runtime implementing every OS call the binary makes",
  });

  // Rung 4 — freestanding
  ladder.push({
    rung: 4,
    id: "freestanding",
    title: "Freestanding / firmware code (no OS imports)",
    status: !hasImports && manifest?.kind === "binary-native" && !isManaged ? (firmwareTarget ? "possible" : "partial") : "not-applicable",
    claim: !hasImports && manifest?.kind === "binary-native" && !isManaged
      ? firmwareTarget
        ? "No DLL/DT_NEEDED imports: lifting + recompiling can produce genuinely runnable firmware code, given target-correct startup code and a smoke run."
        : "No OS imports, but an OS target still needs startup code and possibly syscall/ABI shims. Lift + recompile is a CANDIDATE — runnable status only after poa.verify on the target."
      : hasImports ? `${depsResult.deps.length} OS import(s) found — not freestanding.` : "not a native binary without imports.",
    evidence: hasImports
      ? depsResult.deps.slice(0, 12).map((d) => `import: ${d}`)
      : [depsResult.note ? `scan note: ${depsResult.note}` : "no imports reported"],
  });

  // Rung 5 — OS ABI boundary
  ladder.push({
    rung: 5,
    id: "os-abi-boundary",
    title: "Cross-OS with OS imports",
    status: !samePlatform && hasImports && !isManaged ? "blocked" : "not-applicable",
    claim: !samePlatform && hasImports && !isManaged
      ? `The binary imports ${depsResult.deps.length} OS library(ies). Translating instructions does not translate those APIs. A POSIX implementation of the entire source-OS ABI would be required — POA does not ship one.`
      : "No cross-OS import boundary to report at this rung.",
    evidence: depsResult.deps.slice(0, 20).map((d) => `OS import: ${d}`),
    requirement: `a ${sourceOs ?? "source-OS"}→${targetOs} ABI shim (not present in POA)`,
  });

  // Rung 6 — runtime coupling
  ladder.push({
    rung: 6,
    id: "runtime-coupled",
    title: "Windows-only runtime / drivers",
    status: markers.length > 0 || isManaged ? "impossible" : "not-applicable",
    claim: markers.length > 0 || isManaged
      ? "Runtime and driver bindings are platform-specific. No binary translation can retarget them. POA refuses to claim a runnable port: only a source-level rewrite can change this."
      : "No Windows-only runtime markers detected.",
    evidence: [
      ...(isManaged ? ["managed .NET assembly detected"] : []),
      ...markers.map((m) => `${m.id}: ${m.reason}`),
    ],
    requirement: "source access + a target-native UI/runtime (e.g. Avalonia, WebKitGTK)",
  });

  const blockers: string[] = [];
  if (!samePlatform) {
    if (hasImports) blockers.push(`${depsResult.deps.length} OS imports have no ${targetOs} equivalent in POA`);
    if (markers.length) blockers.push(...markers.map((m) => m.reason));
    if (isManaged) blockers.push("managed .NET/WPF assembly: no Linux runtime for WPF");
  }
  if (!remill && manifest?.kind === "binary-native") blockers.push("no Remill lifter on PATH");

  let bestHonestOutcome: string;
  let canProduceRunnablePort = false;
  let stopAtRung = 6;
  let recommendedChain: string[];

  if (samePlatform) {
    bestHonestOutcome = "Artifact already runs on the target — repackage, LOSSLESS.";
    canProduceRunnablePort = true;
    stopAtRung = 1;
    recommendedChain = ["poa.inspect_input", "poa.scan_dependencies", "poa.verify"];
  } else if (goOk) {
    bestHonestOutcome = "Rebuild from the pinned Go source at the recovered dependency versions (NEAR-LOSSLESS).";
    canProduceRunnablePort = true;
    stopAtRung = 2;
    recommendedChain = ["poa.go_buildinfo", "poa.build", "poa.verify"];
  } else if (!hasImports && manifest?.kind === "binary-native") {
    bestHonestOutcome = firmwareTarget
      ? "Lift to IR + recompile + target startup code can make a real firmware port — verify with poa.verify."
      : "Lift + recompile yields a candidate object; runnable status is UNVERIFIED until poa.verify runs on the target. If source exists, prefer the source path (rung 2).";
    canProduceRunnablePort = firmwareTarget;
    stopAtRung = 4;
    recommendedChain = firmwareTarget ? ["poa.lift", "poa.recompile", "poa.verify"] : ["poa.lift", "poa.recompile", "poa.verify", "source-based port (preferred)"];
  } else {
    bestHonestOutcome = "No runnable native port can be produced from this binary. POA can emit IR/object artifacts for analysis only; a real port needs source.";
    stopAtRung = markers.length || isManaged ? 6 : 5;
    recommendedChain = ["poa.assess_portability", "poa.go_buildinfo", "poa.verify_embedded_assets", "source-based port"];
  }

  return {
    ok: true,
    input: abs,
    sha256,
    target: { os: targetOs, arch: targetArch },
    ladder,
    verdict: {
      magicLift: "refused",
      canProduceRunnablePort,
      bestHonestOutcome,
      stopAtRung,
      blockers,
      recommendedChain,
    },
    evidence: {
      format: manifest?.format ?? "unrecognised",
      arch: sourceArch,
      platformHint: manifest?.platformHint ?? null,
      sourceOs,
      dependencies: depsResult.deps,
      dependencyScanNote: depsResult.note,
      runtimeMarkers: markers.map((m) => m.id),
      goModule,
      goDeps,
      remillAvailable: !!remill,
    },
  };
}
