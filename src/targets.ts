/**
 * POA target profiles.
 *
 * A target is a static description of a device class: arch, OS, RAM, GPU,
 * inputs, display, and accepted binary formats. Adapters (see docs/ROADMAP.md)
 * are generated per target; these profiles are what the discrepancy mapper
 * diffs inputs against.
 */

export type GpuClass =
  | { kind: "hardware"; api: string }
  | { kind: "software-only" }
  | { kind: "unknown" };

export interface TargetProfile {
  id: string;
  description: string;
  arch: string;
  os: string;
  /** Approximate RAM; 0 means "kilobytes in practice" (MCU-class). */
  ramMb: number;
  gpu: GpuClass;
  inputs: string[];
  display: string | null;
  /** Binary formats this target can execute/package. */
  binFormats: string[];
}

export const TARGETS: readonly TargetProfile[] = [
  {
    id: "linux-aarch64-generic",
    description: "Generic ARM64 Linux (Raspberry Pi 4/5, RK3588, servers)",
    arch: "aarch64",
    os: "linux",
    ramMb: 4096,
    gpu: { kind: "hardware", api: "vulkan-1.1+" },
    inputs: ["touch", "keyboard", "gamepad"],
    display: "1920x1080",
    binFormats: ["elf", "wasm"],
  },
  {
    id: "linux-x86_64-generic",
    description: "Generic x86-64 Linux desktop",
    arch: "x86_64",
    os: "linux",
    ramMb: 8192,
    gpu: { kind: "hardware", api: "vulkan-1.2+" },
    inputs: ["keyboard", "mouse", "gamepad"],
    display: "native",
    binFormats: ["elf", "wasm"],
  },
  {
    id: "web-browser",
    description: "Any modern browser via WASM + WebGL/WebGPU",
    arch: "wasm32",
    os: "web",
    ramMb: 2048,
    gpu: { kind: "hardware", api: "webgl2/webgpu" },
    inputs: ["keyboard", "mouse", "gamepad", "touch"],
    display: "viewport",
    binFormats: ["wasm"],
  },
  {
    id: "tv-smarttv-generic",
    description: "Generic smart TV (Tizen/webOS class), 10-foot UI, remote input",
    arch: "aarch64",
    os: "linux-tv",
    ramMb: 1024,
    gpu: { kind: "hardware", api: "gles2" },
    inputs: ["remote-dpad"],
    display: "1280x720",
    binFormats: ["wasm", "tpk/ipk"],
  },
  {
    id: "embedded-cortexm-zephyr",
    description: "Cortex-M MCU running Zephyr RTOS; no MMU, KB-scale RAM",
    arch: "thumbv7em",
    os: "zephyr",
    ramMb: 0,
    gpu: { kind: "software-only" },
    inputs: ["gpio"],
    display: null,
    binFormats: ["elf"],
  },
] as const;

export function findTarget(id: string): TargetProfile | undefined {
  return TARGETS.find((t) => t.id === id);
}
