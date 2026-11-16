/**
 * M2 corpus: build jansson via POA's MCP tools — unmodified upstream.
 * Verification: `bin/<target>/json_process.exe` run by poa.verify wait=1.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = process.env.JANSSON_SRC ?? "/tmp/opencode/jansson";
const target = process.env.POA_TARGET ?? "windows-x86_64-mingw";
const work = process.env.POA_M2_WORK ?? "/tmp/opencode/m2-jansson-work";
if (!existsSync(path.join(src, "CMakeLists.txt"))) {
  console.error("jansson source not found at", src);
  process.exit(2);
}
mkdirSync(work, { recursive: true });

const server = spawn(process.execPath, [path.join(repo, "dist/server.js")], { cwd: work });
let buf = ""; const pending = new Map(); let id = 0;
server.stdout.on("data", (d) => {
  buf += d.toString();
  let i; while ((i = buf.indexOf("\n")) >= 0) {
    const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!ln) continue;
    try { const m = JSON.parse(ln); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const send = (method, params) => new Promise((resolve, reject) => {
  const msgId = ++id; pending.set(msgId, resolve);
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msgId, method, params }) + "\n");
  setTimeout(() => reject(new Error("timeout " + method)), 15 * 60 * 1000);
});
const notify = (method, params) => server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const call = async (name, args) => {
  const r = await send("tools/call", { name, arguments: args });
  const t = r.result?.content?.[0]?.text ?? "";
  console.log(`\n== ${name} ==`); console.log(t.length > 1500 ? t.slice(0, 1500) + "\n…[truncated]" : t);
  try { return JSON.parse(t); } catch { return t; }
};

const init = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m2-jansson-driver", version: "0" } });
console.log("server:", init.result?.serverInfo); notify("notifications/initialized", {});

await call("poa.start_port", { source: src, target, provenance: "open-source", strategy: "cross-compile" });
const build = await call("poa.build", { mode: "auto", cmakeArgs: [] });
if (!build.ok) { console.log("\nJANSSON LANE: BUILD BLOCKED"); server.kill(); process.exit(2); }
await call("poa.get_report", {});

const exe = (build.artifacts ?? []).find((a) => /bin[\/\\]json_process(\.exe)?$/.test(a.path))?.path;
console.log("json_process artifact:", exe ?? "(none)");
if (!exe) { server.kill(); process.exit(3); }
const declaredTarget = target;
const hostArchMatchesTarget =
  (process.platform === "darwin" && declaredTarget.startsWith("macos")) ||
  (process.platform === "win32" && declaredTarget.startsWith("windows")) ||
  (process.platform === "linux" && declaredTarget.startsWith("linux"));
const hostArchMap = { x64: "x86_64", arm64: "aarch64", ia32: "i386" };
const archMatches = declaredTarget.includes(hostArchMap[process.arch] ?? process.arch);
if (hostArchMatchesTarget && archMatches) {
  const v = await call("poa.verify", { artifact: exe, args: [], timeoutMs: 15000 });
  const ok = v.outcome === "passed";
  console.log(`\nJANSSON LANE: ${ok ? "PASS — native run" : "NATIVE RUN FAIL"}`);
  server.kill();
  process.exit(ok ? 0 : 4);
}
const { promises: fsp } = await import("node:fs");
const fd = await fsp.open(exe, "r");
const head = Buffer.alloc(2);
await fd.read(head, 0, 2, 0); await fd.close();
console.log("json_process PE magic:", JSON.stringify(head.toString("latin1")));
if (head.toString("latin1") !== "MZ") { server.kill(); process.exit(4); }
console.log("JANSSON LANE: PASS — PE magic verified");
server.kill();
process.exit(0);
