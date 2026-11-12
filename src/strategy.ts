/**
 * poa.choose_strategy: the decision ladder.
 *
 * Choices are made from evidence (manifest + build system + target profile),
 * never from vibes. Every strategy returns a fidelity tier per the
 * docs/ROADMAP.md contract, and a concrete "what POA does next" chain.
 */

import { hostArch } from "./build.js";
import type { PortManifest } from "./manifest.js";
import type { TargetProfile } from "./targets.js";

export type Strategy =
  | "cross-compile"        // source available, same or different arch → build for target
  | "source-recompile"     // source available, native build (same os/arch)
  | "repackage"            // binary, same OS + same ISA → the artifact IS the port
  | "compat-shim"          // binary-only, same ISA-ish, OS/ABI differs → wrapper layer, declared degradation
  | "lift-to-ir"           // binary-only, arch differs → static retranslation (M3 — not available)
  | "wasm-runtime"         // WASM payload → any target with a WASM runtime
  | "impossible-on-platform"; // platform policy blocks it (e.g. iOS binary porting)

export interface StrategyChoice {
  strategy: Strategy;
  fidelityTier: "LOSSLESS" | "NEAR-LOSSLESS" | "DEGRADED(perf,edge-cases)" | "DEGRADED(policy)";
  confidence: number;
  rationale: string[];
  requires: string[];
  nextSteps: string[];
}

export function chooseStrategy(
  manifest: PortManifest,
  target: TargetProfile,
): StrategyChoice {
  const host = `${process.platform}/${hostArch()}`;

  if (manifest.kind === "source") {
    const sameIsa = manifest.arch === "unknown" || manifest.arch === target.arch;
    const rationale = [
      `source tree detected (${manifest.format})`,
      `build host: ${host} → target: ${target.os}/${target.arch}`,
      "same-code ports are the highest-fidelity class POA can deliver",
    ];
    if (target.os === process.platform && target.arch === hostArch()) {
      return {
        strategy: "source-recompile",
        fidelityTier: "LOSSLESS",
        confidence: 0.95,
        rationale: [...rationale, "same OS and same ISA — native build"],
        requires: ["cmake (or build system of the tree)", "target-side toolchain file (auto for native)"],
        nextSteps: ["poa.start_port", "poa.detect_buildsystem", "poa.build (mode native)", "poa.verify"],
      };
    }
    return {
      strategy: "cross-compile",
      fidelityTier: "NEAR-LOSSLESS",
      confidence: 0.85,
      rationale: [
        ...rationale,
        sameIsa
          ? "source ports: same ISA family; OS/ABI differences handled by target layer"
          : "different ISA — aarch64/arm/riscv cross toolchain required",
        "reference run: Chocolate DOOM → aarch64-linux-musl (docs/m1-port-report.json)",
      ],
      requires: [
        `cross toolchain for ${target.arch} (zig cc, or system ${target.arch}-linux-gnu-gcc)`,
        "CMake toolchain file (poa.build generates when absent: set POA_CMAKE_TOOLCHAIN_FILE to override)",
      ],
      nextSteps: ["poa.start_port", "poa.detect_buildsystem", "poa.build (mode cross)", "poa.verify (qemu-user)"],
    };
  }

  if (manifest.arch === "wasm32" || manifest.format.toLowerCase().includes("wasm")) {
    return {
      strategy: "wasm-runtime",
      fidelityTier: "NEAR-LOSSLESS",
      confidence: 0.9,
      rationale: ["WASM module detected — most portable artifact class", `target formats: ${target.binFormats.join(", ")}`],
      requires: ["WASM runtime on target (wasm3/wasmtime class), or browser"],
      nextSteps: ["poa.start_port", "verify the target has a WASM runtime, or package one", "poa.package (M4)"],
    };
  }

  if (manifest.kind === "binary-native" || manifest.kind === "binary-managed") {
    const sameIsa = manifest.arch !== "unknown" && manifest.arch === target.arch;
    const hint = manifest.platformHint ?? "";
    const linuxish = target.os === "linux" && ["linux", "sysv", "freebsd"].includes(hint);
    const macish = target.os.startsWith("mac") && hint.includes("macos");
    const winish = target.os === "windows" && hint === "windows";
    if (sameIsa && (linuxish || macish || winish || hint === target.os)) {
      return {
        strategy: "repackage",
        fidelityTier: "LOSSLESS",
        confidence: 0.95,
        rationale: [
          `${manifest.format} → ${target.os}/${target.arch}: same OS family, same ISA`,
          "the port is the artifact itself — no translation needed",
          "ship as-is, or wrapped (poa.package, M4) — verify runtime deps with poa.scan_dependencies",
        ],
        requires: ["dependency closure present on the target (poa.scan_dependencies)"],
        nextSteps: ["poa.scan_dependencies", "poa.verify (run under the target or an emulator of it)"],
      };
    }
    if (sameIsa) {
      return {
        strategy: "compat-shim",
        fidelityTier: "DEGRADED(perf,edge-cases)",
        confidence: 0.8,
        rationale: [
          `${manifest.format} → ${target.os}/${target.arch}: same ISA, OS/ABI differs`,
          "no recompiler beats a shim for same-ISA pairs today",
          "Wine-class semantics (files/paths/sockets/threads/time) — matrix in docs/SHIM.md",
          "full static Win32→POSIX translation is deliberately not promised (M3 decides, with evidence)",
        ],
        requires: ["shim layer for the OS-specific API surface used (poa.scan_dependencies tells us which)"],
        nextSteps: ["poa.start_port", "poa.scan_dependencies", "map unresolved imports into the shim", "poa.build or package as compat-runtime"],
      };
    }
    return {
      strategy: "lift-to-ir",
      fidelityTier: "DEGRADED(perf,edge-cases)",
      confidence: 0.2,
      rationale: [
        `${manifest.arch} → ${target.arch}: cross-ISA binary translation needed`,
        "static lift (Remill/McSema class) is M3 and unproven for this binary — confidence 20%",
        "dynamic binary translation (qemu/Box64-class) works but is a runtime, not a ported artifact",
      ],
      requires: ["M3 lifter spike result, or acceptance of DBT runtime packaging"],
      nextSteps: ["poa.scan_dependencies", "poa.request_human — source available? (changes everything)"],
    };
  }

  return {
    strategy: "impossible-on-platform",
    fidelityTier: "DEGRADED(policy)",
    confidence: 0.9,
    rationale: [`${manifest.kind} → ${target.os}: no legal/technical path on the target platform (e.g. iOS JIT ban)`],
    requires: ["source access + target SDKs, or a different target"],
    nextSteps: ["poa.request_human — clarify the target"],
  };
}
