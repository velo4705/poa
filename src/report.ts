/**
 * Port report: the machine-readable artifact every port run emits,
 * success or not. Degradation is declared, never hidden.
 */

import type { DiscrepancyMap } from "./discrepancy.js";
import type { PortManifest } from "./manifest.js";

export type PortStatus = "built-unverified" | "blocked";

export interface PortReport {
  tool: "poa";
  version: string;
  source: string;
  target: string;
  status: PortStatus;
  manifest: PortManifest;
  discrepancies: DiscrepancyMap;
  blockers: Array<{ stage: string; what: string; why: string; ask?: string }>;
  /** Declared quality degradations, e.g. { "texture-format": "ASTC→RGBA4444" } */
  degraded: Record<string, string>;
  generatedAt: string;
}
