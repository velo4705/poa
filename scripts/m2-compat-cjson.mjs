/**
 * M2 corpus: build cJSON via POA's own MCP tools — unmodified upstream.
 * Verification: parse + print roundtrip via cjson-roundtrip.c (built fresh).
 *   ubuntu-latest (POA_CMAKE_TOOLCHAIN_FILE/zig) → PE magic checked
 *   windows-latest, macos-latest                 → native build + verify run
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = process.env.CJSON_SRC ?? "/tmp/opencode/cJSON";
const target = process.env.POA_TARGET ?? "windows-x86_64-mingw";
const work = process.env.POA_M2_WORK ?? "/tmp/opencode/m2-cjson-work";
if (!existsSync(path.join(src, "CMakeLists.txt"))) {
  console.error("cJSON source not found at", src);
  process.exit(2);
}
const verifier = path.join(repo, "scripts/cjson-roundtrip.c");
mkdirSync(work, { recursive: true });

const server = spawn(process.execPath, [path.join(repo, "dist/server.js")], { cwd: work });
let buf = "";
const pending = new Map();
let id = 0;
server.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg); pending.delete(msg.id);
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
const notify = (method, params) => server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const call = async (name, args) => {
  const r = await send("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? "";
  console.log(`\n== ${name} ==`);
  const errLines = text.split("\n").filter((l) => /error|FAILED|undefined symbol|not found/i.test(l));
  if (errLines.length) for (const l of errLines) console.log("  ↳ " + l);
  console.log(text.length > 2000 ? "…[head truncated]\n" + text.slice(-2000) : text);
  try { return JSON.parse(text); } catch { return text; }
};

const init = await send("initialize", {
  protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m2-cjson-driver", version: "0" },
});
console.log("server:", init.result?.serverInfo);
notify("notifications/initialized", {});

await call("poa.start_port", { source: src, target, provenance: "open-source", strategy: "cross-compile" });
const build = await call("poa.build", { mode: "auto", cmakeArgs: ["-DENABLE_CJSON_TEST=OFF", "-DBUILD_SHARED_LIBS=OFF"] });
if (!build.ok) { console.log("\nCJSON LANE: BUILD BLOCKED"); server.kill(); process.exit(2); }
await call("poa.get_report", {});

import { readdirSync, existsSync as ex2 } from "node:fs";
const buildRoot = path.join(work, ".poa", "build");
let libPath = null;
try {
  for (const d of readdirSync(buildRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const c = path.join(buildRoot, d.name, "libcjson.a");
    if (ex2(c)) { libPath = [c]; break; }
  }
} catch { /* fall through to error below */ }
if (!libPath) {
  console.error("could not locate libcjson.a under", buildRoot);
  console.error("candidate dirs:", (() => { try { return readdirSync(buildRoot); } catch { return []; } })());
  server.kill();
  process.exit(3);
}

const cc = process.env.POA_TARGET && process.env.POA_TARGET.startsWith("windows") && process.platform !== "win32"
  ? path.join(repo, "scripts/zig-cross/x86_64-windows-gnu-cc")
  : (process.env.CC ?? (process.platform === "win32" ? "gcc" : "cc"));

const out = path.join(work, process.platform === "win32" ? "cjson-roundtrip.exe" : "cjson-roundtrip");
console.log("link exec:", cc, out);
try {
  execFileSync(cc, ["-I", src, "-o", out, verifier, ...libPath], { stdio: "inherit" });
} catch (err) {
  console.error("verifier link failed:", err?.message ?? err);
  server.kill();
  process.exit(6);
}

if (process.platform === "win32" || process.platform === "darwin") {
  try {
    const stdout = execFileSync(out, [], { encoding: "utf8", timeout: 15000 });
    process.stdout.write(stdout);
    console.log("CJSON LANE: PASS — native roundtrip");
    server.kill();
    process.exit(0);
  } catch (err) {
    console.error("verifier run failed:", err?.message ?? err);
    server.kill();
    process.exit(4);
  }
} else {
  // Linux cross to windows — verify PE magic only
  const fd = await import("node:fs").then((fs) => fs.promises.open(out, "r"));
  const head = Buffer.alloc(2);
  await fd.read(head, 0, 2, 0);
  await fd.close();
  console.log("cjson-roundtrip PE magic:", JSON.stringify(head.toString("latin1")), "(expect MZ)");
  if (head.toString("latin1") !== "MZ") { server.kill(); process.exit(4); }
  console.log("CJSON LANE: PASS — PE magic verified");
  server.kill();
  process.exit(0);
}
