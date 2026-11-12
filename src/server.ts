#!/usr/bin/env node
/**
 * poa-mcp: the POA (Port Anything) MCP server.
 *
 * POA turns software binaries and source into ports for other devices.
 * This server exposes the pipeline as MCP tools so an agent can drive it.
 *
 * Honesty contract: no tool fakes a completed port. The translation engine
 * (docs/ROADMAP.md M3) does not exist; everything here either does real
 * work or reports a structured blocker with the smallest human decision
 * needed to unblock it.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  TARGETS,
  findTargetAsync,
  listUserTargets,
  saveUserTarget,
  targetProfileSchema,
} from "./targets.js";
import { ingest } from "./manifest.js";
import { mapDiscrepancies } from "./discrepancy.js";
import { scanDependencies } from "./scan.js";
import { chooseStrategy } from "./strategy.js";
import { detectBuildSystem } from "./buildsystem.js";
import { buildPort, verifyPort } from "./build.js";
import {
  getSession,
  saveSession,
  startSession,
  appendLog,
  saveReport,
  newEscalationId,
  type Provenance,
} from "./session.js";
import type { PortReport, PortStatus } from "./report.js";

const VERSION = "0.3.0";
const CWD = process.cwd();

const server = new McpServer({ name: "poa", version: VERSION });

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const fail = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

/** A session is actionable while it is current (open or verified). Abandoned sessions are dead. */
async function requireSession(): Promise<Awaited<ReturnType<typeof getSession>>> {
  const session = await getSession(CWD);
  if (!session || session.status === "abandoned") return null;
  return session;
}

/** Assemble the current port report from session + live re-ingestion. */
async function assembleReport(session: NonNullable<Awaited<ReturnType<typeof getSession>>>): Promise<PortReport> {
  const manifest = await ingest(session.source);
  const target = await findTargetAsync(session.target, CWD);
  const discrepancies = target
    ? mapDiscrepancies(manifest, target)
    : { target: session.target, gaps: [], fullyAutomatic: false };
  const blockers: PortReport["blockers"] = [];
  if (!target) {
    blockers.push({
      stage: "scout",
      what: `unknown target '${session.target}'`,
      why: "target disappeared from both built-ins and .poa/targets/",
      ask: "restore the target profile or pick an existing one",
    });
  }
  if (!session.verification) {
    blockers.push({
      stage: "translate",
      what: "artifact not verified yet",
      why: "run poa.build then poa.verify; the lift-to-IR engine is M3",
      ask: "implement M1 build+verify, then treat 'verified' as the only green you trust",
    });
  }
  const status: PortStatus =
    session.verification?.outcome === "passed"
      ? "verified"
      : session.verification
        ? "built-unverified"
        : "blocked";
  return {
    tool: "poa",
    version: VERSION,
    source: session.source,
    target: session.target,
    sessionId: session.id,
    status,
    manifest,
    discrepancies,
    blockers,
    degraded: session.degraded,
    verification: session.verification,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- Stage 1

server.registerTool(
  "poa.list_targets",
  {
    title: "List POA targets",
    description:
      "List all target device profiles POA knows: built-ins plus user-registered .poa/targets/. Advises which ids exist; does not validate executability.",
    inputSchema: {},
  },
  async () => {
    const user = await listUserTargets(CWD);
    return json({
      builtin: TARGETS.map((t) => ({ id: t.id, description: t.description, arch: t.arch, os: t.os })),
      user: user.map((t) => ({ id: t.id, description: t.description, arch: t.arch, os: t.os })),
    });
  },
);

server.registerTool(
  "poa.scout_target",
  {
    title: "Scout a target",
    description:
      "Return the full static profile of one target: arch, OS, RAM budget, GPU class, inputs, display, accepted binary formats. First stage of the POA agent loop.",
    inputSchema: { target: z.string().describe("Target id, e.g. 'linux-aarch64-generic'") },
  },
  async ({ target }) => {
    const profile = await findTargetAsync(target, CWD);
    if (!profile) {
      return fail(
        `Unknown target '${target}'. Known: ${TARGETS.map((t) => t.id).join(", ")} (+ any .poa/targets/*.json)`,
      );
    }
    return json(profile);
  },
);

server.registerTool(
  "poa.inspect_input",
  {
    title: "Inspect a port candidate",
    description:
      "Classify an input file (ELF / PE / Mach-O / WASM / ZIP / raw firmware / source tree) and emit a Port Manifest: kind, arch, bits, endianness, platform hint, confidence, and explicit unknowns. Byte-level detection; no guessing.",
    inputSchema: {
      path: z.string().describe("Absolute or relative path to the input file or source directory"),
    },
  },
  async ({ path: inputPath }) => {
    try {
      return json(await ingest(inputPath));
    } catch (err) {
      return fail(`Ingest failed: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "poa.scan_dependencies",
  {
    title: "Scan dependency closure",
    description:
      "Enumerate a binary's direct dependencies: ELF via readelf (DT_NEEDED), PE via objdump (DLL Name imports), WASM via import-section scan. Reports 'unsupported' honestly for Mach-O/managed bytecode — never invents a list. In a session, defaults to the session source.",
    inputSchema: {
      path: z.string().optional().describe("Path to the binary; defaults to the open session's source"),
    },
  },
  async ({ path: p }) => {
    const session = await getSession(CWD);
    const target = p ?? session?.source;
    if (!target) return fail("No path given and no session — run poa.start_port first or pass 'path'.");
    try {
      return json(await scanDependencies(target));
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  "poa.choose_strategy",
  {
    title: "Choose the porting strategy",
    description:
      "The decision ladder, computed from evidence: source→cross-compile (NEAR-LOSSLESS), source same-OS→native (LOSSLESS), binary same-ISA→compat-shim (DEGRADED), binary cross-ISA→lift-to-IR/DBT (DEGRADED, M3 unproven), WASM→runtime (NEAR-LOSSLESS), iOS-binary/anything policy-blocked→impossible-on-platform. Returns rationale, requirements, and the concrete tool chain to run next.",
    inputSchema: {
      source: z.string().optional().describe("Path to the input; defaults to the open session's source"),
      target: z.string().optional().describe("Target id; defaults to the open session's target"),
    },
  },
  async ({ source, target }) => {
    const session = await getSession(CWD);
    const src = source ?? session?.source;
    const tgt = target ?? session?.target;
    if (!src || !tgt) return fail("Need source and target (or an open session to default them from).");
    const profile = await findTargetAsync(tgt, CWD);
    if (!profile) return fail(`Unknown target '${tgt}'.`);
    let manifest;
    try {
      manifest = await ingest(src);
    } catch (err) {
      return fail(`Ingest failed: ${(err as Error).message}`);
    }
    return json(chooseStrategy(manifest, profile));
  },
);

server.registerTool(
  "poa.detect_buildsystem",
  {
    title: "Detect a source tree's build system",
    description:
      "Walk a source tree (depth ≤ 3) and report candidate build systems with confidence, evidence path, and cross-compile strategy. In a port session, defaults to the session's source.",
    inputSchema: {
      path: z.string().optional().describe("Source tree path; defaults to the open session's source"),
    },
  },
  async ({ path: p }) => {
    const session = await requireSession();
    const root = p ?? session?.source;
    if (!root) return fail("No path given and no open session — run poa.start_port first or pass 'path'.");
    try {
      const candidates = await detectBuildSystem(root);
      return json({ root: path.resolve(CWD, root), candidates });
    } catch (err) {
      return fail(`detect_buildsystem failed: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "poa.add_target",
  {
    title: "Register a custom target",
    description:
      "Validate and store a custom target profile in .poa/targets/<id>.json (e.g. 'my-smart-fridge'). Refuses ids colliding with built-ins. Use for unusual hardware POA doesn't ship with.",
    inputSchema: {
      profile: z
        .string()
        .describe(
          'Target profile as a JSON string, e.g. {"id":"my-fridge","description":"…","arch":"aarch64","os":"linux","ramMb":1024,"gpu":{"kind":"software-only"},"inputs":["touch"],"display":"800x480","binFormats":["wasm","elf"]}',
        ),
    },
  },
  async ({ profile }) => {
    let raw: unknown;
    try {
      raw = JSON.parse(profile);
    } catch {
      return fail("profile is not valid JSON");
    }
    const parsed = targetProfileSchema.safeParse(raw);
    if (!parsed.success) {
      return fail(`profile failed validation:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
    }
    try {
      const file = await saveUserTarget(CWD, parsed.data);
      await appendLog(CWD, { tool: "poa.add_target", event: "target-registered", id: parsed.data.id });
      return json({ stored: file, id: parsed.data.id });
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

// ------------------------------------------------------------- Session ops

server.registerTool(
  "poa.start_port",
  {
    title: "Start a porting session",
    description:
      "Begin a tracked port: bind a source (binary, source tree, firmware image) to a target, record provenance and (optional) strategy. Fails if another session is open. Writes .poa/port.json. Provenance is required — POA does not port what you don't have rights to.",
    inputSchema: {
      source: z.string().describe("Path to the binary / source tree / firmware image"),
      target: z.string().describe("Target id (built-in or registered via poa.add_target)"),
      provenance: z
        .enum(["own-code", "open-source", "licensed"])
        .describe("Why you have the right to port this"),
      strategy: z
        .string()
        .optional()
        .describe("cross-compile | lift-to-ir | wasm | compat-shim — or omit to let poa.choose_strategy decide (M2)"),
    },
  },
  async ({ source, target, provenance, strategy }) => {
    const known = await findTargetAsync(target, CWD);
    if (!known) {
      return fail(
        `Unknown target '${target}'. Use poa.list_targets, or register one with poa.add_target.`,
      );
    }
    try {
      const session = await startSession(CWD, {
        source,
        target,
        provenance: provenance as Provenance,
        ...(strategy !== undefined ? { strategy } : {}),
      });
      return json({ session, next: "poa.plan_port → poa.detect_buildsystem → poa.build → poa.verify" });
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  "poa.port_status",
  {
    title: "Port session status",
    description:
      "Where is the open port? Re-ingests the source, re-maps the discrepancy map against the target, and reports: status, remaining gaps, degradations declared, open escalations, last verification. The scoreboard for the whole port.",
    inputSchema: {},
  },
  async () => {
    const session = await requireSession();
    if (!session) return fail("No open session. Run poa.start_port first.");
    let manifest = null;
    let gaps: unknown = null;
    try {
      manifest = await ingest(session.source);
      const target = await findTargetAsync(session.target, CWD);
      if (target) gaps = mapDiscrepancies(manifest, target).gaps;
    } catch {
      /* ingest failure is itself a reportable condition */
    }
    return json({
      session: {
        id: session.id,
        source: session.source,
        target: session.target,
        provenance: session.provenance,
        strategy: session.strategy,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      manifest,
      gaps,
      degraded: session.degraded,
      escalations: session.escalations.filter((e) => !e.resolved),
      verification: session.verification,
    });
  },
);

server.registerTool(
  "poa.get_report",
  {
    title: "Get the port report",
    description:
      "Assemble and return the current port report (machine-readable) for the open session: manifest, discrepancy map, degradations, verification verdict, honest blockers. Optionally write it to a file.",
    inputSchema: {
      out: z.string().optional().describe("File path to write the report JSON (e.g. '.poa/report.json'). Default: only return it."),
    },
  },
  async ({ out }) => {
    const session = await requireSession();
    if (!session) return fail("No open session. Run poa.start_port first.");
    const report = await assembleReport(session);
    if (out) {
      const file = await saveReport(CWD, report);
      if (out !== file && out !== ".poa/report.json") {
        const abs = path.resolve(CWD, out);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, JSON.stringify(report, null, 2));
        return json({ report, written: abs });
      }
      return json({ report, written: file });
    }
    return json(report);
  },
);

server.registerTool(
  "poa.declare_degradation",
  {
    title: "Declare a quality loss",
    description:
      "Record an accepted quality loss in the port report (e.g. key 'controller-rumble', value 'absent — target has no haptics'). POA's fidelity contract: you may lose something, but it must be written down here, never silently.",
    inputSchema: {
      key: z.string().min(1).describe("What is lost, e.g. 'controller-rumble', 'texture-filtering', 'input-latency'"),
      value: z.string().min(1).describe("How and why, quantified if possible"),
    },
  },
  async ({ key, value }) => {
    const session = await requireSession();
    if (!session) return fail("No open session. Run poa.start_port first.");
    session.degraded[key] = value;
    await saveSession(CWD, session);
    await appendLog(CWD, { tool: "poa.declare_degradation", key, value });
    const report = await assembleReport(session);
    const file = await saveReport(CWD, report);
    return json({ degraded: session.degraded, reportWritten: file });
  },
);

server.registerTool(
  "poa.request_human",
  {
    title: "Escalate to the human",
    description:
      "Ask the human one precise question with explicit options. Escalation is logged in the session; resolve it with poa.resolve_escalation. Use when the discrepancy map says needs-human — never guess on ambiguity.",
    inputSchema: {
      question: z.string().min(1).describe("The exact decision needed, one sentence"),
      options: z.array(z.string().min(1)).min(2).max(6).describe("Concrete options to choose from"),
    },
  },
  async ({ question, options }) => {
    const session = await requireSession();
    if (!session) return fail("No open session. Run poa.start_port first.");
    const esc = { id: newEscalationId(session), at: new Date().toISOString(), question, options, resolved: false };
    session.escalations.push(esc);
    await saveSession(CWD, session);
    await appendLog(CWD, { tool: "poa.request_human", event: "escalated", id: esc.id, question });
    return json(esc);
  },
);

server.registerTool(
  "poa.resolve_escalation",
  {
    title: "Resolve a human escalation",
    description: "Record the human's decision for an open escalation and continue the port.",
    inputSchema: {
      id: z.string().describe("Escalation id from poa.request_human"),
      choice: z.string().describe("The chosen option (verbatim or a clear decision)"),
    },
  },
  async ({ id, choice }) => {
    const session = await requireSession();
    if (!session) return fail("No open session. Run poa.start_port first.");
    const esc = session.escalations.find((e) => e.id === id);
    if (!esc) return fail(`No escalation '${id}' in this session.`);
    if (esc.resolved) return fail(`Escalation '${id}' was already resolved with: ${esc.choice}`);
    esc.resolved = true;
    esc.choice = choice;
    await saveSession(CWD, session);
    await appendLog(CWD, { tool: "poa.resolve_escalation", event: "resolved", id, choice });
    return json({ resolved: esc });
  },
);

// -------------------------------------------------------------- Execution

server.registerTool(
  "poa.build",
  {
    title: "Build the ported source",
    description:
      "Cross-compile (or natively build) the session's source tree with CMake. Generates a toolchain file under .poa/toolchains/ for cross builds, streams no arbitrary commands (fixed cmake invocations only), captures a log tail, and records produced ELF/PE artifacts with their arch via poa.inspect_input's byte detection. Missing cmake/cross-gcc is reported as a structured blocker with install commands — never faked.",
    inputSchema: {
      mode: z.enum(["auto", "native", "cross"]).optional().describe("auto = cross when target arch ≠ host arch"),
      buildDir: z.string().optional().describe("Override build directory (default: .poa/build/<session-id>)"),
      cmakeArgs: z
        .array(z.string().min(1))
        .optional()
        .describe("Extra -D defines appended to cmake configure, e.g. ['-DENABLE_SDL2_MIXER=OFF']"),
    },
  },
  async ({ mode, buildDir, cmakeArgs }) => {
    const session = await requireSession();
    if (!session) return fail("No open session. Run poa.start_port first.");
    try {
      const result = await buildPort(CWD, session, {
        ...(mode !== undefined ? { mode } : {}),
        ...(buildDir !== undefined ? { buildDir } : {}),
        ...(cmakeArgs !== undefined ? { cmakeArgs } : {}),
      });
      await appendLog(CWD, { tool: "poa.build", ok: result.ok, detail: result.detail, artifacts: result.artifacts?.map((a) => a.path) });
      const report = await assembleReport(session);
      await saveReport(CWD, report);
      return json(result);
    } catch (err) {
      return fail(`poa.build crashed internally (this is a bug): ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "poa.verify",
  {
    title: "Verify the ported binary runs",
    description:
      "Run the built artifact under the right harness: native exec for same-arch, qemu-user for cross-arch. Records exit code / timeout into the session and the port report. 'timeout' means it stayed up — normal for interactive apps; 'passed' means clean exit 0. Missing qemu is a structured blocker, never a fake pass.",
    inputSchema: {
      artifact: z.string().optional().describe("Path to the binary to run; default: newest ELF in .poa/build matching the target arch"),
      args: z.array(z.string()).optional().describe("argv for the binary, e.g. ['--help'] or ['-iwad','doom1.wad','-nomusic']"),
      timeoutMs: z.number().int().min(500).max(60000).optional().describe("How long to let it run before declaring 'timeout' (default 15000)"),
      env: z.record(z.string(), z.string()).optional().describe("Extra environment, e.g. {\"SDL_VIDEODRIVER\":\"dummy\"}"),
    },
  },
  async ({ artifact, args, timeoutMs, env }) => {
    const session = await requireSession();
    if (!session) return fail("No open session. Run poa.start_port first.");
    try {
      const result = await verifyPort(CWD, session, {
        ...(artifact !== undefined ? { artifact } : {}),
        ...(args !== undefined ? { args } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(env !== undefined ? { env } : {}),
      });
      if (result.outcome) {
        session.verification = {
          at: new Date().toISOString(),
          mode: "qemu-or-native",
          artifact: result.artifacts?.[0]?.path ?? artifact ?? "unknown",
          exitCode: result.exitCode ?? null,
          outcome: result.outcome,
          outputTail: result.logTail ?? "",
        };
        session.status = result.outcome === "passed" ? "verified" : "open";
        await saveSession(CWD, session);
      }
      await appendLog(CWD, { tool: "poa.verify", ok: result.ok, outcome: result.outcome ?? null, artifact: result.artifacts?.[0]?.path });
      const report = await assembleReport(session);
      await saveReport(CWD, report);
      return json(result);
    } catch (err) {
      return fail(`poa.verify crashed internally (this is a bug): ${(err as Error).message}`);
    }
  },
);

// ----------------------------------------------------------- Plan & tools

server.registerTool(
  "poa.plan_port",
  {
    title: "Plan a port",
    description:
      "Run stages 1–3 of the POA agent loop (scout, ingest, discrepancy map) for an input and a target, and emit a machine-readable port report. Does NOT produce the ported artifact — the translation engine does not exist yet (docs/ROADMAP.md M3). The report states exactly what is automatic, what needs an adapter, and what needs a human.",
    inputSchema: {
      source: z.string().describe("Path to the input binary, source tree, or firmware image"),
      target: z.string().describe("Target id, e.g. 'linux-aarch64-generic'"),
      out: z.string().optional().describe("Optional file path to write the port report JSON (e.g. '.poa/report.json')"),
    },
  },
  async ({ source, target, out }) => {
    const profile = await findTargetAsync(target, CWD);
    if (!profile) {
      return fail(
        `Unknown target '${target}'. Known: ${TARGETS.map((t) => t.id).join(", ")} (+ any .poa/targets/*.json)`,
      );
    }

    let manifest;
    try {
      manifest = await ingest(source);
    } catch (err) {
      return fail(`Ingest failed: ${(err as Error).message}`);
    }

    const discrepancies = mapDiscrepancies(manifest, profile);
    const session = await getSession(CWD);

    const report: PortReport = {
      tool: "poa",
      version: VERSION,
      source: path.resolve(CWD, source),
      target: profile.id,
      ...(session?.id ? { sessionId: session.id } : {}),
      status: session?.verification?.outcome === "passed" ? "verified" : "blocked",
      manifest,
      discrepancies,
      blockers: [
        {
          stage: "translate",
          what: "translation engine not implemented",
          why: "POA is at M1; the lift-to-IR / cross-compile / adapter layers are partially built — cross builds via poa.build work today, generic binary translation is M3",
          ask: "Use poa.start_port → poa.build → poa.verify for source-based ports, or wait for M3",
        },
      ],
      degraded: session?.degraded ?? {},
      verification: session?.verification ?? null,
      generatedAt: new Date().toISOString(),
    };

    if (out) {
      const abs = path.resolve(CWD, out);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, JSON.stringify(report, null, 2));
      return json({ report, written: abs });
    }
    return json(report);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`poa-mcp ${VERSION} ready (stdio, cwd=${CWD})`);
