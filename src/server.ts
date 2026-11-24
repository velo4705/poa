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
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveProjectRoot, resolvePoAHome, readRegistry } from "./config.js";
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
import { liftBinary, recompileFromIr } from "./lift.js";
import { goBuildInfo, verifyEmbeddedAssets, extractDotnet } from "./extract.js";
import { assessPortability } from "./assess.js";
import { decompileNative } from "./decompile.js";
import { convertWpfToAvalonia } from "./convert.js";
import { nextAttempt } from "./motivation.js";
import { portMatrix } from "./matrix.js";
import {
  getSession,
  saveSession,
  startSession,
  appendLog,
  saveReport,
  newEscalationId,
  withLock,
  finishSession,
  type Provenance,
} from "./session.js";
import type { PortReport, PortStatus } from "./report.js";
import { readFileSync } from "node:fs";

// Version comes from package.json — single source of truth, so npm
// version bumps show up here without recompiling or maintaining parallel.
const pkg = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version: string };
const VERSION = pkg.version;
let rootDir = resolveProjectRoot();

const server = new McpServer({ name: "poa", version: VERSION });

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const fail = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

/** Wrap a mutating tool handler in the project's .poa lock. */
const locked = <A, R>(tool: string, handler: (args: A) => Promise<R>) =>
  (args: A): Promise<R> => withLock(rootDir, tool, () => handler(args));

/** A session is actionable while it is current (open or verified). Abandoned sessions are dead. */
async function requireSession(): Promise<Awaited<ReturnType<typeof getSession>>> {
  const session = await getSession(rootDir);
  if (!session || session.status === "abandoned") return null;
  return session;
}

/** Assemble the current port report from session + live re-ingestion. */
async function assembleReport(session: NonNullable<Awaited<ReturnType<typeof getSession>>>): Promise<PortReport> {
  const manifest = await ingest(session.source);
  const target = await findTargetAsync(session.target, rootDir);
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
    const user = await listUserTargets(rootDir);
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
    const profile = await findTargetAsync(target, rootDir);
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
    const session = await getSession(rootDir);
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
    const session = await getSession(rootDir);
    const src = source ?? session?.source;
    const tgt = target ?? session?.target;
    if (!src || !tgt) return fail("Need source and target (or an open session to default them from).");
    const profile = await findTargetAsync(tgt, rootDir);
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
      return json({ root: path.resolve(rootDir, root), candidates });
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
      const file = await saveUserTarget(rootDir, parsed.data);
      await appendLog(rootDir, { tool: "poa.add_target", event: "target-registered", id: parsed.data.id });
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
  locked("poa.start_port", async ({ source, target, provenance, strategy }) => {
    const known = await findTargetAsync(target, rootDir);
    if (!known) {
      return fail(
        `Unknown target '${target}'. Use poa.list_targets, or register one with poa.add_target.`,
      );
    }
    try {
      const session = await startSession(rootDir, {
        source,
        target,
        provenance: provenance as Provenance,
        ...(strategy !== undefined ? { strategy } : {}),
      });
      return json({ session, next: "poa.plan_port → poa.detect_buildsystem → poa.build → poa.verify" });
    } catch (err) {
      return fail((err as Error).message);
    }
  }),
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
      const target = await findTargetAsync(session.target, rootDir);
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
      const file = await saveReport(rootDir, report);
      if (out !== file && out !== ".poa/report.json") {
        const abs = path.resolve(rootDir, out);
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
  locked("poa.declare_degradation", async ({ key, value }) => {
    const session = await requireSession();
    if (!session) return fail("No open session. Run poa.start_port first.");
    session.degraded[key] = value;
    await saveSession(rootDir, session);
    await appendLog(rootDir, { tool: "poa.declare_degradation", key, value });
    const report = await assembleReport(session);
    const file = await saveReport(rootDir, report);
    return json({ degraded: session.degraded, reportWritten: file });
  }),
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
  locked("poa.request_human", async ({ question, options }) => {
    const session = await requireSession();
    if (!session) return fail("No open session. Run poa.start_port first.");
    const esc = { id: newEscalationId(session), at: new Date().toISOString(), question, options, resolved: false };
    session.escalations.push(esc);
    await saveSession(rootDir, session);
    await appendLog(rootDir, { tool: "poa.request_human", event: "escalated", id: esc.id, question });
    return json(esc);
  }),
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
  locked("poa.resolve_escalation", async ({ id, choice }) => {
    const session = await requireSession();
    if (!session) return fail("No open session. Run poa.start_port first.");
    const esc = session.escalations.find((e) => e.id === id);
    if (!esc) return fail(`No escalation '${id}' in this session.`);
    if (esc.resolved) return fail(`Escalation '${id}' was already resolved with: ${esc.choice}`);
    esc.resolved = true;
    esc.choice = choice;
    await saveSession(rootDir, session);
    await appendLog(rootDir, { tool: "poa.resolve_escalation", event: "resolved", id, choice });
    return json({ resolved: esc });
  }),
);

// ----------------------------------------------------- Session management

server.registerTool(
  "poa.sessions",
  {
    title: "List known port sessions",
    description:
      "List every project POA has seen (from the cross-project registry in $POA_HOME/sessions.json, default ~/.config/poa/), re-reading each project's .poa/port.json for live status. Entries whose project moved or was deleted are reported as missing — the registry is an index, the .poa/port.json file is the truth.",
    inputSchema: {},
  },
  async () => {
    const home = resolvePoAHome();
    const entries = await readRegistry(home);
    const out = [];
    for (const e of entries) {
      const session = await getSession(e.root);
      out.push({
        root: e.root,
        id: session?.id ?? e.id,
        target: session?.target ?? e.target,
        status: session?.status ?? "missing", // project dir deleted/moved/cleaned
        lastKnownStatus: e.status,
        updatedAt: session?.updatedAt ?? e.updatedAt,
        current: path.resolve(e.root) === path.resolve(rootDir),
      });
    }
    return json({ registryHome: home, total: out.length, sessions: out });
  },
);

server.registerTool(
  "poa.session_switch",
  {
    title: "Switch the active project",
    description:
      "Point this MCP server at another project directory for all subsequent tool calls. The change lives only in this process — it never edits files by itself. Use with poa.sessions to jump between ports (e.g. a DOOM port in ~/games/doom and a firmware dump in ~/embedded/fridge).",
    inputSchema: {
      root: z.string().describe("Absolute path of the project directory to make active"),
    },
  },
  async ({ root }) => {
    const abs = path.resolve(root);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isDirectory()) return fail(`${abs} is not a directory`);
    } catch {
      return fail(`No such directory: ${abs}`);
    }
    rootDir = abs;
    const session = await getSession(rootDir);
    return json({
      activeRoot: rootDir,
      session: session
        ? {
            id: session.id,
            target: session.target,
            status: session.status,
            verified: session.verification?.outcome ?? "never verified",
          }
        : null,
      note: session ? "session found — poa.port_status shows the full picture" : "no session here yet — poa.start_port will create one",
    });
  },
);

server.registerTool(
  "poa.finish_port",
  {
    title: "Finish (or abandon) the port",
    description:
      "Close the current port session explicitly. decision='keep' requires a prior 'passed' verification (otherwise POA refuses to call it done and tells you to verify or abandon). decision='abandon' retires the session without claiming anything. A note is logged to .poa/port-log.jsonl either way.",
    inputSchema: {
      decision: z.enum(["keep", "abandon"]),
      note: z.string().optional().describe("Free-form note recorded in the port log, e.g. 'shipped as AppImage' or 'blocked on SKU SDK'"),
    },
  },
  locked("poa.finish_port", async ({ decision, note }) => {
    try {
      const session = await finishSession(rootDir, decision, note);
      return json({
        decision,
        session: { id: session.id, status: session.status, updatedAt: session.updatedAt },
      });
    } catch (err) {
      return fail((err as Error).message);
    }
  }),
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
  locked("poa.build", async ({ mode, buildDir, cmakeArgs }) => {
    const session = await requireSession();
    if (!session) return fail("No open session. Run poa.start_port first.");
    try {
      const result = await buildPort(rootDir, session, {
        ...(mode !== undefined ? { mode } : {}),
        ...(buildDir !== undefined ? { buildDir } : {}),
        ...(cmakeArgs !== undefined ? { cmakeArgs } : {}),
      });
      await appendLog(rootDir, { tool: "poa.build", ok: result.ok, detail: result.detail, artifacts: result.artifacts?.map((a) => a.path) });
      const report = await assembleReport(session);
      await saveReport(rootDir, report);
      return json(result);
    } catch (err) {
      return fail(`poa.build crashed internally (this is a bug): ${(err as Error).message}`);
    }
  }),
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
  locked("poa.verify", async ({ artifact, args, timeoutMs, env }) => {
    const session = await requireSession();
    if (!session) return fail("No open session. Run poa.start_port first.");
    try {
      const result = await verifyPort(rootDir, session, {
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
        await saveSession(rootDir, session);
      }
      await appendLog(rootDir, { tool: "poa.verify", ok: result.ok, outcome: result.outcome ?? null, artifact: result.artifacts?.[0]?.path });
      const report = await assembleReport(session);
      await saveReport(rootDir, report);
      return json(result);
    } catch (err) {
      return fail(`poa.verify crashed internally (this is a bug): ${(err as Error).message}`);
    }
  }),
);


// ----------------------------------------------------------- Lift & recompile (experimental — M3)

server.registerTool(
  "poa.lift",
  {
    title: "Lift a native binary to LLVM IR (experimental)",
    description:
      "Static retranslation via Remill: lift a PE / ELF / Mach-O binary to LLVM bitcode for the requested architecture and OS. This is a research spike, not a general translator — the produced IR will need a host-side runtime implementing any OS calls the binary makes. If the lifter fails or the architecture is unsupported, returns a structured blocker. M3 direction.",
    inputSchema: {
      input: z.string().describe("Path to the binary to lift"),
      output: z.string().optional().describe("Where to write the .bc (default: beside the input)"),
      arch: z.enum(["amd64", "x86_64", "i386", "aarch64", "aarch32"]).optional().describe("Override the detected arch"),
      os: z.enum(["windows", "linux", "macos", "solaris"]).optional().describe("OS for the lifter's instruction semantics"),
      range: z.tuple([z.number().int().min(0), z.number().int().min(1)]).optional().describe("Optional [start, end] file offsets to lift a slice"),
    },
  },
  locked("poa.lift", async ({ input, output, arch, os, range }) => {
    const r = await liftBinary({
      input,
      ...(output !== undefined ? { output } : {}),
      ...(arch !== undefined ? { arch } : {}),
      ...(os !== undefined ? { os } : {}),
      ...(range !== undefined ? { range: range as [number, number] } : {}),
    });
    await appendLog(rootDir, { tool: "poa.lift", ok: r.ok, irPath: r.irPath ?? null });
    return json(r);
  }),
);

server.registerTool(
  "poa.recompile",
  {
    title: "Compile lifted IR into a target object (experimental)",
    description:
      "Compile the lifted LLVM bitcode (.ll / .bc) for a target architecture via zig cc. The result is a .o file. This does NOT produce a runnable binary on its own — you still need a host runtime implementing the OS calls that the lifted code makes. Returns a structured blocker if zig or the target triple is unsupported.",
    inputSchema: {
      irPath: z.string().describe("Path to a lifted .ll / .bc producing by poa.lift"),
      targetArch: z.enum(["x86_64", "aarch64", "arm", "i386", "riscv64"]).describe("Target architecture"),
      targetOs: z.enum(["linux", "windows", "macos"]).optional().describe("Default: linux"),
      output: z.string().optional().describe("Output path for the .o (default: ./recompiled/<name>.o)"),
    },
  },
  locked("poa.recompile", async ({ irPath, targetArch, targetOs, output }) => {
    const r = await recompileFromIr({
      irPath,
      targetArch,
      ...(targetOs !== undefined ? { targetOs } : {}),
      ...(output !== undefined ? { output } : {}),
    });
    await appendLog(rootDir, { tool: "poa.recompile", ok: r.ok, output: r.output ?? null });
    return json(r);
  }),
);

// ----------------------------------------------------------- Extraction & verification (M3)

server.registerTool(
  "poa.go_buildinfo",
  {
    title: "Read the Go buildinfo embedded in a Go binary",
    description:
      "Runs `go version -m` and parses it into structured JSON: toolchain version, module path/version, the full dependency graph with h1 hashes, and build settings (GOOS/GOARCH/CGO_ENABLED/tags/-trimpath). Works on stripped Go binaries and survives -trimpath. This is build metadata, not decompiled source. Requires the Go toolchain on PATH.",
    inputSchema: {
      input: z.string().describe("Path to the Go binary (PE, ELF, Mach-O)"),
    },
  },
  locked("poa.go_buildinfo", async ({ input }) => {
    const r = await goBuildInfo(input);
    await appendLog(rootDir, { tool: "poa.go_buildinfo", ok: r.ok, module: r.module ?? null });
    return json(r);
  }),
);

server.registerTool(
  "poa.verify_embedded_assets",
  {
    title: "Prove reference files appear byte-identically inside a binary",
    description:
      "Walks a reference directory (e.g. a freshly built frontend/dist) and checks whether each file's bytes appear inside the target binary. Byte-exact match first, CRLF-normalized fallback for Windows-built artifacts. Returns per-file offset/size/sha256 and a summary; writes a JSON report if `output` is given. Does not decompile code — and reports not-found honestly rather than guessing.",
    inputSchema: {
      input: z.string().describe("Path to the target binary"),
      referenceDir: z.string().describe("Path to the reference directory of files to locate inside the binary"),
      output: z.string().optional().describe("Optional path to write the JSON report (e.g. '.poa/embedded-assets.json')"),
    },
  },
  locked("poa.verify_embedded_assets", async ({ input, referenceDir, output }) => {
    const r = await verifyEmbeddedAssets({ input, referenceDir, ...(output !== undefined ? { output } : {}) });
    await appendLog(rootDir, { tool: "poa.verify_embedded_assets", ok: r.ok, found: r.foundByteIdentical + r.foundCrlfNormalized, total: r.total });
    return json(r);
  }),
);

// ----------------------------------------------------------- Managed source extraction (M3)

server.registerTool(
  "poa.extract_dotnet",
  {
    title: "Recover C# source from a .NET assembly and map its Windows dependencies",
    description:
      "Uses ilspycmd to recover faithful C# from .NET IL (not machine code), then scans the source for P/Invoke imports and UI framework markers and returns a Windows→Linux dependency map. Writes the decompiled project into outputDir. Honest limits: BAML views need manual XAML retargeting, native P/Invoke targets are machine code, and no runnable Linux binary is produced. Requires ilspycmd on PATH.",
    inputSchema: {
      input: z.string().describe("Path to the managed .NET assembly (PE with CLR header)"),
      outputDir: z.string().describe("Directory to write the decompiled C# project into"),
    },
  },
  locked("poa.extract_dotnet", async ({ input, outputDir }) => {
    const r = await extractDotnet({ input, outputDir });
    await appendLog(rootDir, { tool: "poa.extract_dotnet", ok: r.ok, files: r.sourceFiles, pinvokes: r.pinvokes.length });
    return json(r);
  }),
);

// ----------------------------------------------------------- Native decompilation (M3)

server.registerTool(
  "poa.decompile_native",
  {
    title: "Decompile native machine code to pseudo-C via Ghidra",
    description:
      "Runs Ghidra headless to decompile functions from a native binary into C. Honest limit: the result is Ghidra pseudo-C (undefined types, LOCK/UNLOCK macros, vtables, undecompiled helper calls) — NOT compilable port source without a compatibility header and human repair. Never claims a working port. Requires Ghidra + JDK 21+.",
    inputSchema: {
      input: z.string().describe("Native binary (PE/ELF/Mach-O) to decompile"),
      outputDir: z.string().describe("Directory for generated pseudo-C and Ghidra project"),
      filter: z.string().optional().describe("Only decompile functions whose names contain this substring"),
      maxFunctions: z.number().int().min(1).max(2000).optional().describe("Max functions to decompile (default 40)"),
    },
  },
  locked("poa.decompile_native", async ({ input, outputDir, filter, maxFunctions }) => {
    const r = await decompileNative({
      input, outputDir,
      ...(filter !== undefined ? { filter } : {}),
      ...(maxFunctions !== undefined ? { maxFunctions } : {}),
    });
    await appendLog(rootDir, { tool: "poa.decompile_native", ok: r.ok, functions: r.functions });
    return json(r);
  }),
);

// ----------------------------------------------------------- Source conversion (M3)

server.registerTool(
  "poa.convert_wpf_to_avalonia",
  {
    title: "Convert decompiled WPF C# source to an Avalonia project skeleton",
    description:
      "Copies a decompiled .NET/WPF project, maps System.Windows.* namespaces to Avalonia equivalents, injects generated source-level declarations for WPF-only types, and writes a net8.0 Avalonia entry point. This is a source-to-source STARTING POINT, not a completed port: BAML views are not recovered, stubs preserve signatures only, the native engine is untouched, and the build needs per-API repair. Run poa.build on the output for an honest error count.",
    inputSchema: {
      input: z.string().describe("Directory of decompiled WPF C# source"),
      outputDir: z.string().describe("Directory to write the Avalonia port skeleton"),
    },
  },
  locked("poa.convert_wpf_to_avalonia", async ({ input, outputDir }) => {
    const r = await convertWpfToAvalonia({ input, outputDir });
    await appendLog(rootDir, { tool: "poa.convert_wpf_to_avalonia", ok: r.ok, files: r.filesCopied });
    return json(r);
  }),
);

// ----------------------------------------------------------- Any OS → Any OS matrix

server.registerTool(
  "poa.port_matrix",
  {
    title: "Plan one input against every target OS/architecture",
    description:
      "The Any OS → Any OS planner. Ingests the input once and runs the real strategy ladder + discrepancy mapper for every registered target (or a specified subset). Each row states the strategy, fidelity tier, gap count, requirements and next steps. This is a plan, not a produced port: source + target adapters is the universal path; binary→binary remains a narrow declared exception.",
    inputSchema: {
      input: z.string().describe("Path to the source tree, binary, firmware image or WASM module"),
      targets: z.array(z.string()).optional().describe("Target ids to include (default: all built-in + registered)"),
    },
  },
  locked("poa.port_matrix", async ({ input, targets }) => {
    const r = await portMatrix({ input, ...(targets !== undefined ? { targets } : {}), cwd: rootDir });
    await appendLog(rootDir, { tool: "poa.port_matrix", ok: r.ok, rows: r.rows.length });
    return json(r);
  }),
);

// ----------------------------------------------------------- Never-stop motivation

server.registerTool(
  "poa.next_attempt",
  {
    title: "Generate the next genuinely different porting attempt",
    description:
      "Never-stop loop for POA: given a goal and a precise blocker, reframe it and return at least three genuinely different mechanisms (decompose, change representation, search prior art, remove an assumption, minimal experiment, change tool, analogy) with the smallest verifiable step and the evidence that would prove success. Declares honest stop conditions only for missing rights/permission, explicit user constraints, proven physical limits, or irreversible actions.",
    inputSchema: {
      goal: z.string().describe("Porting goal, e.g. 'run this Epson app natively on Linux'"),
      blocker: z.string().describe("Exact observed blocker, not a vague 'impossible'"),
      tried: z.array(z.string()).optional().describe("Approaches already tried, to avoid repeating them"),
    },
  },
  locked("poa.next_attempt", async ({ goal, blocker, tried }) => {
    const r = nextAttempt({ goal, blocker, ...(tried !== undefined ? { tried } : {}) });
    await appendLog(rootDir, { tool: "poa.next_attempt", attempts: r.attempts.length });
    return json(r);
  }),
);

// ----------------------------------------------------------- Honesty ladder (README promise)

server.registerTool(
  "poa.assess_portability",
  {
    title: "Assess a binary's portability from possible to impossible",
    description:
      "Enforces the README promise: 'Lift a binary to a different platform by magic — POA refuses to pretend.' Walks a binary through an ordered ladder (same-platform → source-derived → IR/object → freestanding → OS ABI → runtime coupling), reporting at each rung what POA can honestly build with measured evidence (imports, Go buildinfo, runtime markers, lifter availability). Returns a machine-readable refusal of magic lifts, the rung where feasibility stops, and the recommended honest tool chain. Use before attempting any binary port.",
    inputSchema: {
      input: z.string().describe("Path to the binary to assess"),
      targetOs: z.string().optional().describe("Target OS id (default: linux)"),
      targetArch: z.string().optional().describe("Target architecture (default: x86_64)"),
    },
  },
  locked("poa.assess_portability", async ({ input, targetOs, targetArch }) => {
    const r = await assessPortability({
      input,
      ...(targetOs !== undefined ? { targetOs } : {}),
      ...(targetArch !== undefined ? { targetArch } : {}),
    });
    await appendLog(rootDir, { tool: "poa.assess_portability", ok: r.ok, stopAtRung: r.verdict.stopAtRung, magicLift: r.verdict.magicLift });
    return json(r);
  }),
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
    const profile = await findTargetAsync(target, rootDir);
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
    const session = await getSession(rootDir);

    const report: PortReport = {
      tool: "poa",
      version: VERSION,
      source: path.resolve(rootDir, source),
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
      const abs = path.resolve(rootDir, out);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, JSON.stringify(report, null, 2));
      return json({ report, written: abs });
    }
    return json(report);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`poa-mcp ${VERSION} ready (stdio, cwd=${rootDir})`);
