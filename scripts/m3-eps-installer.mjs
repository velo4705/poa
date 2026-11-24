#!/usr/bin/env node
/**
 * Drive the Linux installer port entirely through POA MCP tools:
 * start_port → detect_buildsystem → build → verify (CLI install test).
 * Run inside a shell that provides gtk4, cmake, ninja and pkg-config.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cwd = mkdtempSync(path.join(tmpdir(), "poa-eps-inst-"));
const server = spawn(process.execPath, [path.resolve("dist/server.js")], {
  cwd, env: { ...process.env, POA_PROJECT_ROOT: cwd },
});
let buf = ""; const pending = new Map(); let id = 0;
server.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* noise */ }
  }
});
server.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
const send = (method, params) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, res);
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
  setTimeout(() => rej(new Error(`timeout ${method}`)), 300000);
});
const call = async (name, args) => {
  const r = await send("tools/call", { name, arguments: args });
  const t = r.result?.content?.[0]?.text ?? "";
  try { return JSON.parse(t); } catch { return { raw: t }; }
};
await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "eps-installer", version: "0" } });
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

const src = path.resolve("scripts/epson-installer");
const payload = path.resolve(".poa/ipro/out/Program Files/EPSON Projector/Epson iProjection");
const prefix = path.resolve(".poa/epson-prefix");
console.log("start_port:", (await call("poa.start_port", { source: src, target: "linux-x86_64-generic", provenance: "own-code", strategy: "source-recompile" })).ok);
const bs = await call("poa.detect_buildsystem", {});
console.log("buildsystem:", (bs.candidates ?? []).map((c) => c.system).join(", "));
const build = await call("poa.build", { mode: "native" });
console.log("build:", build.ok, build.detail ?? "", build.blocker?.why ?? "");
if (!build.ok) console.log("logTail:", (build.logTail ?? "").slice(-1200));
if (build.ok) {
  console.log("artifacts:", (build.artifacts ?? []).map((a) => a.path).join(" "));
  const v = await call("poa.verify", { args: ["--cli-install", payload, prefix], timeoutMs: 10000 });
  console.log("verify:", JSON.stringify(v).slice(0, 500));
  // Verify the app engine against a local projector simulator.
  const sim = spawn("python3", [path.resolve("scripts/epson-installer/simulator.py"), "14352"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1500));
  const ev = await call("poa.verify", { args: ["--status", "127.0.0.1", "--port", "14352"], timeoutMs: 10000 });
  console.log("engine verify:", JSON.stringify(ev).slice(0, 600));
  sim.kill();
}
const exited = new Promise((r) => { server.once("exit", r); setTimeout(r, 5000); });
server.kill(); await exited;
rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
