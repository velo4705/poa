#!/usr/bin/env node
/**
 * The agent loop: use POA's MCP tools to CONVERT a binary, not just assess it.
 *
 *   node scripts/agent-convert.mjs <binary> [--target-os linux] [--target-arch x86_64]
 *                                  [--source /path/to/source-tree]
 *                                  [--out .poa/conversions]
 *
 * What it does (all work is done by poa.* tool calls over MCP):
 *   1. poa.assess_portability  → which rung is reachable
 *   2. rung 1  (same platform): poa.inspect_input + poa.scan_dependencies → repackage
 *   3. rung 2  (pinned source): poa.go_buildinfo; if --source is given, drive
 *                               poa.start_port → poa.detect_buildsystem →
 *                               poa.choose_strategy → poa.build → poa.verify
 *   4. rung 4  (freestanding):  poa.lift → poa.recompile → IR + object artifacts
 *   5. rung 5/6 (blocked):      write a machine-readable REFUSAL — never a fake binary
 *
 * Every outcome is written as a conversion report under --out. Artifacts are real
 * files produced by tools; if a tool returns a blocker, the report records it verbatim.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const binary = argv[0];
if (!binary || binary.startsWith("--")) {
  console.error("usage: node scripts/agent-convert.mjs <binary> [--target-os ...] [--target-arch ...] [--source ...] [--out ...]");
  process.exit(2);
}
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const targetOs = flag("target-os", "linux");
const targetArch = flag("target-arch", "x86_64");
const sourceTree = flag("source", null);
const outDir = path.resolve(flag("out", ".poa/conversions"));

const sessionCwd = mkdtempSync(path.join(tmpdir(), "poa-convert-"));
const serverCwd = process.env.POA_REPO ?? process.cwd();
const server = spawn(process.execPath, [path.join(serverCwd, "dist/server.js")], { cwd: sessionCwd });
let buf = "";
const pending = new Map();
let id = 0;
server.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* noise */ }
  }
});
server.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
const send = (method, params) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, resolve);
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msgId, method, params }) + "\n");
  setTimeout(() => reject(new Error(`timeout ${method}`)), 180000);
});
const call = async (name, args) => {
  const r = await send("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return { ok: false, raw: text }; }
};

await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "agent-convert", version: "0" } });
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

const input = path.resolve(binary);
const report = {
  agent: "agent-convert",
  binary: input,
  target: { os: targetOs, arch: targetArch },
  startedAt: new Date().toISOString(),
  toolTrace: [],
  artifacts: [],
  outcome: null,
};
const trace = async (tool, args, result) => {
  report.toolTrace.push({ tool, args, ok: result?.ok !== false });
  console.log(`  ${result?.ok === false ? "FAIL" : " ok "} ${tool}`);
  return result;
};

console.log(`converting ${path.basename(input)} → ${targetOs}/${targetArch}`);
mkdirSync(outDir, { recursive: true });
const assessment = await trace("poa.assess_portability", { input, targetOs, targetArch },
  await call("poa.assess_portability", { input, targetOs, targetArch }));
report.assessment = assessment.verdict ?? { refused: true, reason: assessment.blocker?.why };

const rung = assessment.verdict?.stopAtRung ?? 0;
let outcome;

if (rung === 1) {
  const ins = await trace("poa.inspect_input", { input }, await call("poa.inspect_input", { input }));
  const deps = await trace("poa.scan_dependencies", { input }, await call("poa.scan_dependencies", { input }));
  const artifact = path.join(outDir, `${path.basename(input)}-${targetArch}`);
  copyFileSync(input, artifact);
  report.artifacts.push({ path: artifact, kind: "repackaged-binary", verified: false });
  outcome = "REPACKAGE: artifact already targets the requested platform (LOSSLESS).";
  report.details = { inspect: ins, dependencies: deps };
} else if (rung === 2) {
  const go = await trace("poa.go_buildinfo", { input }, await call("poa.go_buildinfo", { input }));
  report.details = { goBuildInfo: go };
  if (sourceTree) {
    const src = path.resolve(sourceTree);
    await trace("poa.start_port", { source: src, target: `${targetOs}-${targetArch}-generic`, provenance: "rights-holder", strategy: "source-recompile" },
      await call("poa.start_port", { source: src, target: `${targetOs}-${targetArch}-generic`, provenance: "rights-holder", strategy: "source-recompile" }));
    report.details.buildSystem = await trace("poa.detect_buildsystem", {}, await call("poa.detect_buildsystem", {}));
    report.details.strategy = await trace("poa.choose_strategy", { source: src, target: `${targetOs}-${targetArch}-generic` },
      await call("poa.choose_strategy", { source: src, target: `${targetOs}-${targetArch}-generic` }));
    const built = await trace("poa.build", { mode: "native" }, await call("poa.build", { mode: "native" }));
    report.details.build = built;
    if (built.ok) {
      const verified = await trace("poa.verify", { timeoutMs: 5000 }, await call("poa.verify", { timeoutMs: 5000 }));
      report.details.verification = verified;
      outcome = built.ok && verified.outcome === "passed"
        ? "SOURCE REBUILD VERIFIED: Linux artifact built from pinned source and smoke-tested."
        : "SOURCE REBUILD BUILT BUT UNVERIFIED: check report.details.verification.";
      for (const a of built.artifacts ?? []) report.artifacts.push({ path: a.path, kind: "source-rebuild", verified: verified.outcome === "passed" });
    } else {
      outcome = "SOURCE REBUILD BLOCKED: " + (built.blocker?.why ?? "unknown");
    }
  } else {
    outcome = "SOURCE REQUIRED: buildinfo pins the exact source/deps; pass --source to have POA build it.";
  }
} else if (rung === 4) {
  const bc = path.join(outDir, `${path.basename(input)}.bc`);
  const obj = path.join(outDir, `${path.basename(input)}-${targetArch}.o`);
  const lift = await trace("poa.lift", { input, output: bc, arch: "amd64", os: assessment.evidence?.sourceOs === "windows" ? "windows" : "linux" },
    await call("poa.lift", { input, output: bc, arch: "amd64", os: assessment.evidence?.sourceOs === "windows" ? "windows" : "linux" }));
  report.details = { lift };
  if (lift.ok) report.artifacts.push({ path: bc, kind: "llvm-bitcode", verified: false });
  const rec = await trace("poa.recompile", { irPath: bc, targetArch, targetOs, output: obj },
    await call("poa.recompile", { irPath: bc, targetArch, targetOs, output: obj }));
  report.details.recompile = rec;
  if (rec.ok) report.artifacts.push({ path: obj, kind: "relocatable-object", verified: false });
  outcome = rec.ok
    ? "FREESTANDING LIFT+RECOMPILE: IR and object produced. Runnable status requires target startup code + poa.verify (not yet performed)."
    : `LIFT/RECOMPILE BLOCKED: ${rec.blocker?.what ?? "unknown"}`;
} else {
  outcome = `REFUSED (no runnable conversion): ${assessment.verdict?.bestHonestOutcome ?? "rung blocked"}`;
  report.details = {
    blockers: assessment.verdict?.blockers ?? [],
    reason: "POA will not emit a fake binary; a magic lift is impossible at this rung.",
  };
}

report.outcome = outcome;
report.finishedAt = new Date().toISOString();
const reportPath = path.join(outDir, `${path.basename(input)}.conversion.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\nOUTCOME: ${outcome}`);
console.log(`REPORT:  ${reportPath}`);
for (const a of report.artifacts) console.log(`ARTIFACT: ${a.kind} — ${a.path}`);

const exited = new Promise((resolve) => { server.once("exit", resolve); setTimeout(resolve, 5000); });
server.kill();
await exited;
rmSync(sessionCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
