/**
 * M1 gate driver: dogsfood POA's own MCP server to port Chocolate DOOM
 * (source, open-source) to linux-aarch64-generic, headless.
 *
 * Run inside the dev shell so cmake/qemu/cross-gcc are on PATH:
 *   nix develop --command node scripts/m1-doom.mjs
 *
 * Session state is written to /tmp/opencode/m1-work (cleaned on success unless
 * POA_M1_KEEP=1). The port report is written to .poa/report.json there.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const doom = process.env.DOOM_SRC ?? "/tmp/opencode/chocolate-doom";
const work = process.env.POA_M1_WORK ?? "/tmp/opencode/m1-work";
mkdirSync(work, { recursive: true });

const server = spawn("node", [path.join(repo, "dist/server.js")], { cwd: work });
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
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* not json */ }
  }
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const send = (method, params) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msgId, method, params }) + "\n");
    setTimeout(() => reject(new Error("timeout " + method)), 15 * 60 * 1000); // builds take a while
  });
const notify = (method, params) =>
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

const call = async (name, args) => {
  const r = await send("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? "";
  console.log(`\n== ${name} ==`);
  console.log(text.length > 2000 ? text.slice(0, 2000) + "\n…[truncated]" : text);
  try { return JSON.parse(text); } catch { return text; }
};

const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "m1-driver", version: "0" },
});
console.log("server:", init.result?.serverInfo);
notify("notifications/initialized", {});

await call("poa.start_port", { source: doom, target: "linux-aarch64-generic", provenance: "open-source", strategy: "cross-compile" });
await call("poa.detect_buildsystem", {});
await call("poa.plan_port", { source: doom, target: "linux-aarch64-generic" });

const build = await call("poa.build", { mode: "cross", cmakeArgs: ["-DENABLE_SDL2_MIXER=OFF", "-DENABLE_SDL2_NET=OFF"] });
if (!build.ok) {
  console.log("\nM1 GATE: BUILD BLOCKED — see logTail above. This is a finding, not a failure of the tool; report it upstream in the roadmap.");
  server.kill();
  process.exit(2);
}

const verify = await call("poa.verify", {
  args: ["--version"],
  timeoutMs: 30000,
  env: { SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
});
const report = await call("poa.get_report", {});
// Persist the gate evidence in the repo docs/ directory.
try {
  const { copyFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  copyFileSync(path.join(work, ".poa", "report.json"), path.join(repo, "docs", "m1-port-report.json"));
  console.log("report copied to docs/m1-port-report.json");
} catch (e) {
  console.log("could not copy report into docs/:", e.message);
}

const pass = verify.outcome === "passed";
console.log(`\nM1 GATE: ${pass ? "PASS — Chocolate DOOM (aarch64-linux) built and answered --version via qemu-user" : "verify outcome = " + verify.outcome + " (see logTail)"}`);

if (pass && !process.env.POA_M1_KEEP) rmSync(work, { recursive: true, force: true });
server.kill();
process.exit(pass ? 0 : 3);
