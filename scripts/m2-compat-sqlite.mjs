/**
 * M2 corpus lane: build SQLite's shell from the official amalgamation via
 * POA's own MCP tools, for an arbitrary target.
 *
 *   POA_SQLITE_SRC=/path/to/sqlite-amalgamation-3540100 \
 *     POA_CMAKE_SOURCE=<repo>/scripts/compat-sqlite \
 *     POA_CMAKE_TOOLCHAIN_FILE=<repo>/scripts/zig-cross/windows-gnu-toolchain.cmake \
 *     POA_TARGET windows-x86_64-mingw
 *
 * The wrapper scripts/compat-sqlite/CMakeLists.txt consumes the amalgamation
 * via -DSQLITE_SRC_DIR=…; the amalgamation itself is never modified.
 * On Windows (native target): also runs `sqlite3 --version` via poa.verify.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = process.env.POA_SQLITE_SRC ?? "/tmp/opencode/sqlite-amalgamation/sqlite-amalgamation-3540100";
const target = process.env.POA_TARGET ?? "windows-x86_64-mingw";
const work = process.env.POA_M2_WORK ?? "/tmp/opencode/m2-sqlite-work";
if (!existsSync(path.join(src, "sqlite3.c"))) {
  console.error(`SQLite amalgamation not found at ${src} — download it first:`);
  console.error("  curl -sLo a.zip https://sqlite.org/2026/sqlite-amalgamation-3540100.zip");
  console.error("  python3 -c \"import zipfile; zipfile.ZipFile('a.zip').extractall('.')\"");
  process.exit(2);
}
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
  clientInfo: { name: "m2-sqlite-driver", version: "0" },
});
console.log("server:", init.result?.serverInfo);
notify("notifications/initialized", {});

await call("poa.start_port", { source: src, target, provenance: "open-source", strategy: "cross-compile" });
await call("poa.choose_strategy", {});
const build = await call("poa.build", {
  mode: "auto", // cross when host/target mismatch, native otherwise
  cmakeArgs: [
    `-DSQLITE_SRC_DIR=${src}`,
    "-DSQLITE_THREADSAFE=1",
    "-DCMAKE_BUILD_TYPE=Release",
  ],
});
if (!build.ok) {
  console.log("\nSQLITE LANE: BUILD BLOCKED — a finding, not a failure; report it upstream.");
  server.kill();
  process.exit(2);
}
await call("poa.get_report", {});

const exe = (build.artifacts ?? []).find((a) => /sqlite3/i.test(a.path))?.path;
console.log("artifact:", exe ?? "(none matching /sqlite3/)");
if (process.platform === "win32") {
  const verify = await call("poa.verify", { artifact: exe, args: ["--version"], timeoutMs: 15000 });
  const ok = verify.outcome === "passed";
  console.log(`\nSQLITE LANE: ${ok ? "PASS — native windows-x86_64 run" : "NATIVE RUN FAIL"}`);
  server.kill();
  process.exit(ok ? 0 : 4);
}
server.kill();
process.exit(0);
