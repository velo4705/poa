/**
 * Minimal stdio smoke test for poa-mcp.
 * Spawns the server, performs the MCP handshake, lists tools, and calls each.
 */
import { spawn } from "node:child_process";

const server = spawn("node", ["dist/server.js"], { cwd: process.cwd() });
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

const call = async (name, args) => {
  const r = await send("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text;
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log(`\n== ${name} ==`);
  console.log(JSON.stringify(parsed, null, 2));
  return parsed;
};

await call("poa.list_targets", {});
await call("poa.scout_target", { target: "linux-aarch64-generic" });
await call("poa.scout_target", { target: "nope" });
await call("poa.inspect_input", { path: "/bin/ls" });
await call("poa.plan_port", { source: "/bin/ls", target: "linux-aarch64-generic" });

server.kill();
process.exit(0);
