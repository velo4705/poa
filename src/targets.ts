/**
 * POA target profiles.
 *
 * Built-in targets plus user-registered ones in `.poa/targets/*.json`
 * (see poa.add_target). User profiles are validated strictly with zod —
 * a malformed fridge definition fails loudly, not at port time.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const gpuClassSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hardware"), api: z.string().min(1) }),
  z.object({ kind: z.literal("software-only") }),
  z.object({ kind: z.literal("unknown") }),
]);

export const targetProfileSchema = z.object({
  id: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase alphanumeric with dashes"),
  description: z.string().min(1),
  arch: z.string().min(1),
  os: z.string().min(1),
  /** Approximate RAM in MiB; 0 = kilobytes in practice (MCU-class). */
  ramMb: z.number().int().min(0),
  gpu: gpuClassSchema,
  inputs: z.array(z.string().min(1)).min(1),
  display: z.string().nullable(),
  /** Binary formats this target can execute/package ("elf", "wasm", "pe", "apk"...). */
  binFormats: z.array(z.string().min(1)).min(1),
});

export type TargetProfile = z.infer<typeof targetProfileSchema>;

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

export function findBuiltinTarget(id: string): TargetProfile | undefined {
  return TARGETS.find((t) => t.id === id);
}

export async function loadUserTarget(cwd: string, id: string): Promise<TargetProfile | undefined> {
  const file = path.join(cwd, ".poa", "targets", `${id}.json`);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = targetProfileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

export async function findTargetAsync(id: string, cwd: string): Promise<TargetProfile | undefined> {
  return findBuiltinTarget(id) ?? (await loadUserTarget(cwd, id));
}

export async function saveUserTarget(cwd: string, profile: TargetProfile): Promise<string> {
  const dir = path.join(cwd, ".poa", "targets");
  await fs.mkdir(dir, { recursive: true });
  if (findBuiltinTarget(profile.id)) {
    throw new Error(`'${profile.id}' collides with a built-in target id — choose another id`);
  }
  const file = path.join(dir, `${profile.id}.json`);
  await fs.writeFile(file, JSON.stringify(profile, null, 2));
  return file;
}

export async function listUserTargets(cwd: string): Promise<TargetProfile[]> {
  const dir = path.join(cwd, ".poa", "targets");
  try {
    const files = await fs.readdir(dir);
    const out: TargetProfile[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const t = await loadUserTarget(cwd, f.slice(0, -5));
      if (t) out.push(t);
    }
    return out;
  } catch {
    return [];
  }
}
