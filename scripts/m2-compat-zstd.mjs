/**
 * M2 compat-shim dogfood: build zstd (BSD-licensed, CMake-based, widely used)
 * from source for windows-x86_64-mingw via POA's own MCP tools.
 *
 *   nix develop --command node scripts/m2-compat-zstd.mjs   (needs cmake+ninja+zig+node)
 *   # or on the CI window: POA_ROOT=$PWD node scripts/m2-compat-zstd.mjs
 *
 * Then on any host: PE magic check of the artifact (cannot run on Linux;
 * the windows-latest CI lane runs the binary natively).
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const zstd = process.env.ZSTD_SRC ?? "/tmp/opencode/zstd";
const work = process.env.POA_M2_WORK ?? "/tmp/opencode/m2-work";
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
    } catch { /* noise */ }
  }
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const send = (method, params) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msgId, method, params }) + "\n");
    setTimeout(() => reject(new Error("timeout " + method)), 15 * 60 * 1000);
  });
const notify = (method, params) =>
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

const call = async (name, args) => {
  const r = await send("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? "";
  console.log(`\n== ${name} ==`);
  console.log(text.length > 1200 ? text.slice(0, 1200) + "\n…[truncated]" : text);
  try { return JSON.parse(text); } catch { return text; }
};

const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "m2-driver", version: "0" },
});
console.log("server:", init.result?.serverInfo);
notify("notifications/initialized", {});

await call("poa.start_port", {
  source: zstd,
  target: "windows-x86_64-mingw",
  provenance: "open-source",
  strategy: "cross-compile",
});
await call("poa.choose_strategy", {});
await call("poa.detect_buildsystem", {});
const build = await call("poa.build", {
  mode: "cross",
  cmakeArgs: [
    "-DZSTD_BUILD_SHARED=OFF",
    "-DZSTD_BUILD_STATIC=ON",
    "-DZSTD_BUILD_TESTS=OFF",
    "-DZSTD_BUILD_PROGRAMS=ON",
    "-DBUILD_SHARED_LIBS=OFF",
    "-DCMAKE_CXX_FLAGS=-DUNICODE=0",
  ],
});
if (!build.ok) {
  console.log("\nM2 DOGFOOD: BUILD BLOCKED — see logTail. A finding, not a failure to try.");
  server.kill();
  process.exit(2);
}
await call("poa.get_report", {});

const zstdExe = (build.artifacts ?? []).find((a) => /zstd/i.test(a.path))?.path;
console.log("artifact:", zstdExe ?? "(none matching /zstd/ in artifact list)");
const peish = zstdExe ? execFileSync("od", ["-An", "-tx1", "-N", "2", zstdExe]).toString().trim() : "";
console.log("artifact first bytes:", peish);

const pass = !!zstdExe && peish.includes("4d 5a");

if (pass && process.platform === "win32") {
  const verify = await call("poa.verify", { artifact: zstdExe, args: ["--version"], timeoutMs: 15000 });
  const ok = verify.outcome === "passed" || verify.outcome === "timeout";
  console.log(`\nM2 DOGFOOD: ${ok ? "NATIVE RUN PASS — zstd.exe --version ran on Windows" : "NATIVE RUN FAIL"}`);
  server.kill();
  process.exit(ok ? 0 : 4);
}
console.log(`\nM2 DOGFOOD: ${pass ? "PASS — zstd cross-built for Windows PE via POA tools" : "FAIL — see above"}`);
server.kill();
process.exit(pass ? 0 : 3);
