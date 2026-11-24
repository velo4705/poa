/**
 * poa.port_matrix — one input, every registered target.
 *
 * The "Any OS → Any OS" planner. It ingests the input once, then for each
 * target profile runs the real strategy ladder and discrepancy mapper, so the
 * agent sees which targets are a build away and which need adapters or source.
 * It never claims a port: every row is a plan with declared fidelity and
 * requirements, not a produced artifact.
 */
import path from "node:path";
import { ingest } from "./manifest.js";
import { mapDiscrepancies } from "./discrepancy.js";
import { chooseStrategy } from "./strategy.js";
import { TARGETS, findTargetAsync, type TargetProfile } from "./targets.js";

export interface MatrixRow {
  target: string;
  os: string;
  arch: string;
  strategy: string;
  fidelityTier: string;
  confidence: number;
  discrepancyCount: number;
  requires: string[];
  nextSteps: string[];
  rationale: string[];
}

export interface PortMatrix {
  ok: boolean;
  input: string;
  manifestSummary: { kind: string; format: string; arch: string; platformHint: string | null } | null;
  rows: MatrixRow[];
  rule: string;
  blocker?: { what: string; why: string };
}

export async function portMatrix(opts: { input: string; targets?: string[]; cwd?: string }): Promise<PortMatrix> {
  const cwd = opts.cwd ?? process.cwd();
  const input = path.resolve(cwd, opts.input);
  let manifest;
  try { manifest = await ingest(input); }
  catch (e) {
    return { ok: false, input, rows: [], rule: "", manifestSummary: null, blocker: { what: "ingest failed", why: (e as Error).message } };
  }
  const ids = opts.targets ?? TARGETS.map((t) => t.id);
  const profiles: TargetProfile[] = [];
  for (const id of ids) {
    const p = await findTargetAsync(id, cwd);
    if (p) profiles.push(p);
  }
  const rows: MatrixRow[] = profiles.map((target) => {
    const choice = chooseStrategy(manifest, target);
    const dm = mapDiscrepancies(manifest, target);
    const gaps = dm.gaps ?? [];
    return {
      target: target.id, os: target.os, arch: target.arch,
      strategy: choice.strategy, fidelityTier: choice.fidelityTier,
      confidence: choice.confidence,
      discrepancyCount: gaps.length,
      requires: [...(choice.requires ?? []), ...gaps.filter((g) => g.resolution !== "auto").map((g) => `${g.resolution}: ${g.need}`)],
      nextSteps: choice.nextSteps ?? [],
      rationale: choice.rationale ?? [],
    };
  });
  return {
    ok: true,
    input,
    manifestSummary: { kind: manifest.kind, format: manifest.format, arch: manifest.arch, platformHint: manifest.platformHint },
    rows,
    rule: "Same code + target adapters is the universal path. Binary→binary is a narrow, declared-exception case; never silently claimed.",
  };
}
