/**
 * POA host configuration.
 *
 * Resolution order for the project root (where `.poa/` state lives):
 *   1. --project <dir> on the server's argv
 *   2. POA_PROJECT_ROOT environment variable
 *   3. process.cwd()
 *
 * The global registry (cross-project session index) lives in POA_HOME:
 *   POA_HOME || XDG_CONFIG_HOME/poa || ~/.config/poa
 *
 * The registry holds only pointers — status is re-read from each project's
 * .poa/port.json, so a moved/deleted project shows up as 'missing', not as a lie.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export function resolveProjectRoot(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
  const i = argv.indexOf("--project");
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]!);
  if (env.POA_PROJECT_ROOT) return path.resolve(env.POA_PROJECT_ROOT);
  return process.cwd();
}

export function resolvePoAHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.POA_HOME) return path.resolve(env.POA_HOME);
  const base = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(os.homedir(), ".config");
  return path.join(base, "poa");
}

export interface RegistryEntry {
  root: string;
  id: string;
  target: string;
  provenance: string;
  status: string;
  updatedAt: string;
}

function registryPath(home: string): string {
  return path.join(home, "sessions.json");
}

export async function readRegistry(home: string): Promise<RegistryEntry[]> {
  try {
    const raw = await fs.readFile(registryPath(home), "utf8");
    const parsed = JSON.parse(raw) as { entries?: RegistryEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

export async function upsertRegistryEntry(home: string, entry: RegistryEntry): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  const entries = await readRegistry(home);
  const idx = entries.findIndex((e) => e.root === entry.root);
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  await fs.writeFile(registryPath(home), JSON.stringify({ entries }, null, 2));
}
