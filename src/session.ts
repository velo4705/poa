/**
 * POA porting sessions: `.poa/port.json` + `.poa/port-log.jsonl` in the
 * server's working directory (CWD-scoped by design — each project keeps its
 * own port state).
 *
 * A session binds: source + target + provenance + strategy. Everything an
 * agent does during a port is appended to the log; escalations to humans and
 * declared degradations live in the session record and in the port report.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolvePoAHome, upsertRegistryEntry } from "./config.js";

export type Provenance = "own-code" | "open-source" | "licensed";
export type SessionStatus = "open" | "verified" | "abandoned";

export interface Escalation {
  id: string;
  at: string;
  question: string;
  options: string[];
  resolved: boolean;
  choice?: string;
}

export interface PortSession {
  id: string;
  source: string;
  target: string;
  provenance: Provenance;
  strategy: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  /** Machine-readable quality losses the port accepts, e.g. {"controller-rumble": "absent on target"} */
  degraded: Record<string, string>;
  escalations: Escalation[];
  /** Verification result, once poa.verify runs. */
  verification: null | {
    at: string;
    mode: string;
    artifact: string;
    exitCode: number | null;
    outcome: "passed" | "failed" | "timeout";
    outputTail: string;
  };
}

const STATE_DIR = ".poa";
const SESSION_FILE = "port.json";
const REPORT_FILE = "report.json";
const LOG_FILE = "port-log.jsonl";
const TARGETS_DIR = "targets";
export const PORT_DIR_FILES = [SESSION_FILE, REPORT_FILE, LOG_FILE] as const;

export function stateDir(cwd: string): string {
  return path.join(cwd, STATE_DIR);
}

export function userTargetsDir(cwd: string): string {
  return path.join(cwd, STATE_DIR, TARGETS_DIR);
}

const LOCK_FILE = "port.lock";
const LOCK_TTL_MS = 15 * 60 * 1000;

/**
 * Mutual exclusion for mutating poa.* tools within one project's .poa/.
 * A lock left behind by a crashed agent clears after 15 minutes; a live
 * lock makes concurrent mutation fail fast with the holder's identity.
 */
export async function withLock<T>(
  cwd: string,
  tool: string,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureStateDir(cwd);
  const lockPath = path.join(stateDir(cwd), LOCK_FILE);
  const payload = JSON.stringify({ pid: process.pid, tool, at: new Date().toISOString() });

  const acquire = async (): Promise<void> => {
    try {
      await fs.writeFile(lockPath, payload, { flag: "wx" });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      const stat = await fs.stat(lockPath).catch(() => null);
      const stale = stat ? Date.now() - stat.mtimeMs > LOCK_TTL_MS : true;
      if (!stale) {
        let holder = "unknown";
        try {
          const cur = JSON.parse(await fs.readFile(lockPath, "utf8"));
          holder = `pid ${cur.pid} (${cur.tool}, since ${cur.at})`;
        } catch {
          /* unreadable lock — still fresh by mtime */
        }
        throw new Error(
          `port session locked by ${holder}. Another POA agent may be working here; wait for it to finish. If that agent died, the lock clears automatically after 15 minutes.`,
        );
      }
      await appendLog(cwd, { tool: "poa.lock", event: "stale-lock-taken", lockFile: lockPath });
      await fs.writeFile(lockPath, payload, { flag: "wx" }); // throws EEXIST if raced — honest failure
    }
  };

  await acquire();
  try {
    return await fn();
  } finally {
    await fs.unlink(lockPath).catch(() => {
      /* lock already cleared — fine */
    });
  }
}

async function ensureStateDir(cwd: string): Promise<string> {
  const dir = stateDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function getSession(cwd: string): Promise<PortSession | null> {
  try {
    const raw = await fs.readFile(path.join(stateDir(cwd), SESSION_FILE), "utf8");
    return JSON.parse(raw) as PortSession;
  } catch {
    return null;
  }
}

export async function saveSession(cwd: string, session: PortSession): Promise<void> {
  await ensureStateDir(cwd);
  session.updatedAt = new Date().toISOString();
  await fs.writeFile(path.join(stateDir(cwd), SESSION_FILE), JSON.stringify(session, null, 2));
  try {
    await upsertRegistryEntry(resolvePoAHome(), {
      root: path.resolve(cwd),
      id: session.id,
      target: session.target,
      provenance: session.provenance,
      status: session.status,
      updatedAt: session.updatedAt,
    });
  } catch {
    // Registry failure must never corrupt the session itself — the .poa/port.json
    // in the project is the source of truth; the registry is a convenience index.
  }
}

export async function appendLog(cwd: string, entry: Record<string, unknown>): Promise<void> {
  await ensureStateDir(cwd);
  await fs.appendFile(
    path.join(stateDir(cwd), LOG_FILE),
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
  );
}

export async function startSession(
  cwd: string,
  args: { source: string; target: string; provenance: Provenance; strategy?: string },
): Promise<PortSession> {
  const existing = await getSession(cwd);
  if (existing && existing.status === "open") {
    throw new Error(
      `an open port session '${existing.id}' already exists in ${cwd} — finish/abandon it, or remove .poa/port.json`,
    );
  }
  const abs = path.resolve(cwd, args.source);
  await fs.access(abs); // throws if source missing — honest failure
  const id =
    path.basename(abs).replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 32) +
    "-" +
    createHash("sha256").update(abs + Date.now()).digest("hex").slice(0, 6);

  const session: PortSession = {
    id,
    source: abs,
    target: args.target,
    provenance: args.provenance,
    strategy: args.strategy ?? null,
    status: "open",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    degraded: {},
    escalations: [],
    verification: null,
  };
  await saveSession(cwd, session);
  await appendLog(cwd, { tool: "poa.start_port", event: "session-created", id, source: abs, target: args.target });
  return session;
}

export async function finishSession(
  cwd: string,
  decision: "keep" | "abandon",
  note?: string,
): Promise<PortSession> {
  const session = await getSession(cwd);
  if (!session) throw new Error("no port session in this project — nothing to finish");
  if (decision === "keep") {
    if (session.status === "verified") {
      // already verified — just record the note and refresh the registry
    } else if (session.verification?.outcome === "passed") {
      session.status = "verified";
    } else {
      throw new Error(
        "cannot 'keep' an unverified session — outcome was never 'passed'. Use decision='abandon' (or run poa.verify first).",
      );
    }
  } else {
    session.status = "abandoned";
  }
  if (note) await appendLog(cwd, { tool: "poa.finish_port", note });
  await saveSession(cwd, session);
  return session;
}

export function newEscalationId(session: PortSession): string {
  return `esc-${session.escalations.length + 1}-${Date.now().toString(36)}`;
}

export async function saveReport(cwd: string, report: unknown): Promise<string> {
  await ensureStateDir(cwd);
  const file = path.join(stateDir(cwd), REPORT_FILE);
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  return file;
}
