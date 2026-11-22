/**
 * Build-system detection for source trees.
 * Walks a bounded tree (depth ≤ 3, no node_modules/.git) and returns
 * candidate build systems with confidence — never a blind guess.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export interface BuildSystemCandidate {
  system: string;
  confidence: number;
  evidence: string;
  entrypoints: string[];
  /** Cross-compile support hint for poa.build. */
  crossCompile: "native" | "toolchain-file" | "container" | "unknown";
}

const SKIP_DIRS = new Set([".git", "node_modules", ".poa", "build", "out", "dist", "target", "__pycache__"]);

const MARKERS: Array<{ file: string; system: string; confidence: number; cross: BuildSystemCandidate["crossCompile"] }> =
  [
    { file: "CMakeLists.txt", system: "cmake", confidence: 0.95, cross: "toolchain-file" },
    { file: "meson.build", system: "meson", confidence: 0.95, cross: "toolchain-file" },
    { file: "configure", system: "autotools", confidence: 0.85, cross: "toolchain-file" },
    { file: "autogen.sh", system: "autotools", confidence: 0.6, cross: "toolchain-file" },
    { file: "Cargo.toml", system: "cargo", confidence: 0.95, cross: "toolchain-file" },
    { file: "go.mod", system: "go", confidence: 0.95, cross: "toolchain-file" },
    { file: "*.csproj", system: "dotnet", confidence: 0.9, cross: "native" },
    { file: "package.json", system: "npm", confidence: 0.8, cross: "native" },
    { file: "pyproject.toml", system: "python", confidence: 0.8, cross: "native" },
    { file: "pom.xml", system: "maven", confidence: 0.9, cross: "native" },
    { file: "build.gradle", system: "gradle", confidence: 0.85, cross: "native" },
    { file: "build.gradle.kts", system: "gradle", confidence: 0.85, cross: "native" },
    { file: "SConstruct", system: "scons", confidence: 0.9, cross: "toolchain-file" },
    { file: "wscript", system: "waf", confidence: 0.85, cross: "toolchain-file" },
    { file: "Makefile", system: "make", confidence: 0.7, cross: "toolchain-file" },
    { file: "BUILD", system: "bazel", confidence: 0.8, cross: "toolchain-file" },
  ];

async function walk(root: string, depth: number, dir: string, hits: Map<string, string>) {
  if (depth > 3) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(root, depth + 1, path.join(dir, e.name), hits);
      continue;
    }
    const marker = MARKERS.find((m) => m.file === e.name
      || (m.file.startsWith("*.") && e.name.toLowerCase().endsWith(m.file.slice(1).toLowerCase())));
    if (marker && !hits.has(marker.system)) {
      hits.set(marker.system, path.relative(root, path.join(dir, e.name)));
    }
  }
}

export async function detectBuildSystem(sourcePath: string): Promise<BuildSystemCandidate[]> {
  const root = path.resolve(sourcePath);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    return []; // single-file input: no build system to detect
  }
  const hits = new Map<string, string>();
  await walk(root, 0, root, hits);

  const candidates: BuildSystemCandidate[] = [];
  for (const [system, evidenceRel] of hits) {
    const marker = MARKERS.find((m) => m.system === system)!;
    candidates.push({
      system,
      confidence: marker.confidence,
      evidence: evidenceRel,
      entrypoints: system === "npm" ? ["npm run build", "npm test"] : [evidenceRel],
      crossCompile: marker.cross,
    });
  }
  // Prefer the strongest markers first.
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates;
}
