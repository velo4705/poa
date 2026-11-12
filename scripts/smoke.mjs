import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const sessionCwd = mkdtempSync(path.join(tmpdir(), "poa-smoke-"));
const serverCwd = process.env.POA_REPO ?? process.cwd();
const inspectPath = process.env.POA_INSPECT ?? "/bin/ls";
console.log("inspecting:", inspectPath);
console.log("session cwd:", sessionCwd, "| repo:", serverCwd);

const server = spawn("node", [path.join(serverCwd, "dist/server.js")], { cwd: sessionCwd });
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
    } catch { /* noise */ }
  }
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

function send(method, params) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msgId, method, params }) + "\n");
    setTimeout(() => reject(new Error("timeout " + method)), 15000);
  });
}
const notify = (method, params) =>
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "0" },
});
console.log("initialize ->", init.result?.serverInfo);
notify("notifications/initialized", {});

const tools = await send("tools/list", {});
const names = tools.result.tools.map((t) => t.name);
console.log("tools ->", names.join(", "));

const call = async (name, args, opts = {}) => {
  const r = await send("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? "";
  console.log(`\n== ${name} ==`);
  const print = text.length > 1500 && opts.truncate !== false ? text.slice(0, 1500) + "\n…[truncated]" : text;
  console.log(print);
  try { return JSON.parse(text); } catch { return text; }
};

const poaRepo = serverCwd;
await call("poa.list_targets", {}, { truncate: true });
await call("poa.start_port", { source: poaRepo, target: "linux-aarch64-generic", provenance: "own-code", strategy: "cross-compile" });
await call("poa.detect_buildsystem", {});
await call("poa.plan_port", { source: poaRepo, target: "linux-aarch64-generic" }, { truncate: true });
await call("poa.scan_dependencies", { path: inspectPath });
await call("poa.choose_strategy", { source: poaRepo, target: "linux-aarch64-generic" });
await call("poa.build", {});          // no $DISPLAY/aarch64 gcc expected — must fail gracefully
await call("poa.verify", { timeoutMs: 1000 }); // no artifact built — must fail gracefully
await call("poa.declare_degradation", { key: "smoke-test", value: "declared during smoke test" });
const esc = await call("poa.request_human", { question: "Proceed with CMake cross build?", options: ["yes", "no"] });
await call("poa.resolve_escalation", { id: esc.id, choice: "yes" });
await call("poa.port_status", {});
await call("poa.get_report", {}, { truncate: true });
await call("poa.add_target", {
  profile: JSON.stringify({
    id: "smoke-fridge-v1",
    description: "Smoke-test smart fridge",
    arch: "aarch64",
    os: "linux",
    ramMb: 1024,
    gpu: { kind: "software-only" },
    inputs: ["touch"],
    display: "800x480",
    binFormats: ["wasm"],
  }),
});
await call("poa.scout_target", { target: "smoke-fridge-v1" });
await call("poa.finish_port", { decision: "abandon", note: "smoke test cleanup" });
await call("poa.sessions", {}, { truncate: true });
await call("poa.session_switch", { root: serverCwd });

server.kill();
rmSync(sessionCwd, { recursive: true, force: true });
console.log("\nsmoke: PASS (session dir cleaned)");
process.exit(0);
