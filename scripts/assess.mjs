#!/usr/bin/env node
/**
 * Drive poa.assess_portability over MCP for one or more binaries.
 *
 *   node scripts/assess.mjs /bin/ls ./binary_test/gitlimp.exe
 *   POA_TARGET_OS=linux POA_TARGET_ARCH=aarch64 node scripts/assess.mjs ./firmware.bin
 *
 * Prints the possible→impossible ladder and the refusal verdict for each input.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const sessionCwd = mkdtempSync(path.join(tmpdir(), "poa-assess-"));
const serverCwd = process.env.POA_REPO ?? process.cwd();
const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error("usage: node scripts/assess.mjs <binary> [binary ...]");
  process.exit(2);
}
const targetOs = process.env.POA_TARGET_OS ?? "linux";
const targetArch = process.env.POA_TARGET_ARCH ?? "x86_64";

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
  setTimeout(() => reject(new Error(`timeout ${method}`)), 60000);
});

await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "assess", version: "0" } });
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

let exitCode = 0;
for (const input of inputs) {
  const r = await send("tools/call", {
    name: "poa.assess_portability",
    arguments: { input: path.resolve(input), targetOs, targetArch },
  });
  const text = r.result?.content?.[0]?.text ?? "";
  let a;
  try { a = JSON.parse(text); } catch { console.error(`bad response for ${input}:`, text); exitCode = 1; continue; }
  console.log(`\n=== ${path.basename(a.input || input)} → ${targetOs}/${targetArch} ===`);
  if (!a.ok) { console.log("BLOCKER:", a.blocker?.why ?? "assessment failed"); exitCode = 1; continue; }
  for (const rung of a.ladder) {
    if (rung.status === "not-applicable") continue;
    const mark = { possible: "OK", partial: "PART", conditional: "IF", blocked: "BLOCK", impossible: "NO" }[rung.status];
    console.log(` [${mark}] ${rung.rung}. ${rung.title} — ${rung.claim}`);
  }
  console.log(`MAGIC LIFT: ${a.verdict.magicLift} (refusal is unconditional)`);
  console.log(`STOP: rung ${a.verdict.stopAtRung} — ${a.verdict.bestHonestOutcome}`);
  console.log(`CHAIN: ${a.verdict.recommendedChain.join(" → ")}`);
  if (a.verdict.blockers.length) console.log(`BLOCKERS: ${a.verdict.blockers.slice(0, 3).join(" | ")}`);
}

const exited = new Promise((resolve) => { server.once("exit", resolve); setTimeout(resolve, 5000); });
server.kill();
await exited;
rmSync(sessionCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exit(exitCode);
