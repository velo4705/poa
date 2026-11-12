/**
 * Discrepancy mapper: diffs a Port Manifest against a target profile and
 * produces a structured gap list, each gap tagged by who can close it.
 *
 * Honesty rule: this function never claims a gap is closed. It only
 * classifies. Actual closure happens in the translation engine, which does
 * not exist yet — see docs/ROADMAP.md.
 */

import type { PortManifest } from "./manifest.js";
import type { TargetProfile } from "./targets.js";

export type GapResolution = "auto" | "needs-adapter" | "needs-human";

export interface CapabilityGap {
  need: string;
  detail: string;
  resolution: GapResolution;
}

export interface DiscrepancyMap {
  target: string;
  gaps: CapabilityGap[];
  fullyAutomatic: boolean;
}

function archCompatible(inputArch: string, targetArch: string): boolean {
  if (inputArch === "unknown" || targetArch === "unknown") return false;
  if (inputArch === "wasm32") return targetArch === "wasm32";
  return inputArch === targetArch;
}

export function mapDiscrepancies(manifest: PortManifest, target: TargetProfile): DiscrepancyMap {
  const gaps: CapabilityGap[] = [];

  // --- Binary format acceptance -------------------------------------------------
  const fmt =
    manifest.kind === "binary-native"
      ? manifest.format.startsWith("ELF")
        ? "elf"
        : manifest.format.startsWith("PE")
          ? "pe"
          : manifest.format.startsWith("Mach-O")
            ? "macho"
            : "unknown"
      : manifest.kind === "binary-managed"
        ? manifest.arch === "wasm32"
          ? "wasm"
          : "managed"
        : manifest.kind;

  if (manifest.kind !== "source" && !target.binFormats.includes(fmt)) {
    gaps.push({
      need: `execute ${fmt} on ${target.id}`,
      detail: `target accepts [${target.binFormats.join(", ")}]; manifest is ${fmt}`,
      resolution: "needs-adapter",
    });
  }

  // --- Instruction set translation ----------------------------------------------
  if (
    manifest.kind !== "source" &&
    manifest.arch !== "unknown" &&
    !archCompatible(manifest.arch, target.arch)
  ) {
    gaps.push({
      need: `translate ${manifest.arch} → ${target.arch}`,
      detail:
        manifest.arch === "wasm32"
          ? "target needs a WASM runtime (wasm-only targets handle this in adapter)"
          : "static binary translation or lift-to-IR + recompile (M3)",
      resolution: "needs-adapter",
    });
  }

  // --- Source inputs: cross-compilation -----------------------------------------
  if (manifest.kind === "source" && manifest.arch !== target.arch) {
    gaps.push({
      need: `cross-compile for ${target.arch}`,
      detail: "orchestrated toolchain (CMake toolchain file / Nix / cross-clang)",
      resolution: "auto",
    });
  }

  // --- RAM ----------------------------------------------------------------------
  if (target.ramMb > 0 && target.ramMb <= 1024 && manifest.kind === "binary-native") {
    gaps.push({
      need: "memory footprint ≤ target RAM",
      detail: `target has ${target.ramMb} MiB; no static analysis of binary footprint exists yet — needs measurement`,
      resolution: "needs-human",
    });
  }
  if (target.ramMb === 0) {
    gaps.push({
      need: "fit within MCU SRAM/flash budget",
      detail: "bare-metal targets require manual memory budgeting (POA-Embedded, M7)",
      resolution: "needs-human",
    });
  }

  // --- GPU ----------------------------------------------------------------------
  if (target.gpu.kind === "software-only") {
    gaps.push({
      need: "graphics without GPU",
      detail: "any 3D/UI acceleration must be software-rasterised or removed; port likely degrades to text/framebuffer",
      resolution: "needs-adapter",
    });
  }

  // --- Input remapping ----------------------------------------------------------
  const expectsPointer = ["mouse"];
  const expectsPointerTarget = target.inputs.some((i) => expectsPointer.includes(i));
  if (!expectsPointerTarget && manifest.kind === "binary-native") {
    gaps.push({
      need: "input remapping (if the payload is interactive)",
      detail: `target inputs are [${target.inputs.join(", ")}]; pointer-centric software needs a remap policy — CLI tools can ignore this`,
      resolution: "needs-adapter",
    });
  }

  // --- Explicit unknowns from ingestion ------------------------------------------
  for (const u of manifest.unknowns) {
    gaps.push({
      need: "unresolved: " + u.split("(")[0]!.trim(),
      detail: u,
      resolution: "needs-human",
    });
  }

  return {
    target: target.id,
    gaps,
    fullyAutomatic: gaps.every((g) => g.resolution !== "needs-human"),
  };
}
