/**
 * M2 corpus: build libzip via POA — unmodified upstream.
 * Verifies roundtrip via zlib-zip-check.c (create→list→extract).
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = process.env.LIBZIP_SRC ?? "/tmp/opencode/libzip";
const target = process.env.POA_TARGET ?? "windows-x86_64-mingw";
const work = process.env.POA_M2_WORK ?? "/tmp/opencode/m2-libzip-work";
const zlocal = process.env.ZLIB_ROOT ?? "/tmp/opencode/zlocal";
if (!existsSync(path.join(src, "CMakeLists.txt"))) {
  console.error("libzip source not found at", src);
  process.exit(2);
}
// Locate a zlib static lib: our zig-cross build produces libzs.a;
// brew (macOS) produces libz.a; explicit ZLIB_LIBRARY env wins.
const zlibLib = (() => {
  if (process.env.ZLIB_LIBRARY && existsSync(process.env.ZLIB_LIBRARY)) return process.env.ZLIB_LIBRARY;
  for (const cand of ["libzs.a", "libz.a"]) {
    const p2 = path.join(zlocal, "lib", cand);
    if (existsSync(p2)) return p2;
  }
  // brew stores it under lib too; on failure tell the user exactly what's missing
  console.error("no zlib static lib in", zlocal, "/lib (looked for libzs.a, libz.a)");
  process.exit(2);
})();
if (!existsSync(path.join(zlocal, "include"))) {
  console.error("local zlib not found at", zlocal, "— build with: git clone --depth 1 https://github.com/madler/zlib && cmake --install");
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

const init = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m2-libzip-driver", version: "0" } });
console.log("server:", init.result?.serverInfo); notify("notifications/initialized", {});

await call("poa.start_port", { source: src, target, provenance: "open-source", strategy: "cross-compile" });
const build = await call("poa.build", {
  mode: "auto",
  cmakeArgs: [
    // NOTE: -D on cmake only sets *cmake cache variables*; to inject compiler
    // macros they have to live inside -DCMAKE_C_FLAGS (one argv element —
    // spaces inside it survive because children are spawned without a shell).
    "-DBUILD_SHARED_LIBS=OFF",
    "-DWIN32=OFF",
    "-DCMAKE_C_FLAGS=-D_GNU_SOURCE -D_FORTIFY_SOURCE=0 -DDWORD_MAX=0xFFFFFFFF",
    `-DZLIB_ROOT=${zlocal}`,
    `-DZLIB_INCLUDE_DIR=${zlocal}/include`,
    `-DZLIB_LIBRARY=${zlibLib}`,
  ],
});
if (!build.ok) { console.log("\nLIBZIP LANE: BUILD BLOCKED"); server.kill(); process.exit(2); }
await call("poa.get_report", {});

const { readdirSync, existsSync: ex2 } = await import("node:fs");
const buildRoot = path.join(work, ".poa", "build");
let libDir = null;
try {
  for (const d of readdirSync(buildRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const c = path.join(buildRoot, d.name, "lib", "libzip.a");
    if (ex2(c)) { libDir = path.join(buildRoot, d.name, "lib"); break; }
  }
} catch { /* fall through */ }
if (!libDir) {
  console.error("could not locate lib/libzip.a under", buildRoot);
  console.error("candidate dirs:", (() => { try { return readdirSync(buildRoot); } catch { return []; } })());
  server.kill();
  process.exit(3);
}
// zipconf.h is generated into the build root, not <build>/lib
const genDir = path.dirname(libDir);

const cc = process.platform === "win32" || process.platform === "darwin"
  ? (process.env.CC ?? "gcc")
  : path.join(repo, "scripts/zig-cross/x86_64-windows-gnu-cc");
const out = path.join(work, "zip-check.exe");
try {
  execFileSync(cc, [
    `-I${src}/lib`,
    `-I${genDir}`,
    `-I${zlocal}/include`,
    "-o", out,
    path.join(repo, "scripts/zlib-zip-check.c"),
    path.join(libDir, "libzip.a"),
    zlibLib,
    ...(target.includes("windows") || target.includes("mingw") ? ["-lbcrypt"] : []),
  ], { stdio: "inherit" });
} catch (err) { console.error("zip-check link failed:", err?.message ?? err); server.kill(); process.exit(6); }

if (process.platform === "win32" || process.platform === "darwin") {
  try {
    const stdout = execFileSync(out, [], { encoding: "utf8", timeout: 15000 });
    process.stdout.write(stdout);
    console.log("LIBZIP LANE: PASS — native roundtrip"); server.kill(); process.exit(0);
  } catch (err) { console.error("zip-check run failed:", err?.message ?? err); server.kill(); process.exit(4); }
} else {
  // Linux cross build to Windows – PE magic only
  const { promises: fsp } = await import("node:fs");
  const fd = await fsp.open(out, "r"); const head = Buffer.alloc(2);
  await fd.read(head, 0, 2, 0); await fd.close();
  console.log("zip-check PE magic:", JSON.stringify(head.toString("latin1")));
  if (head.toString("latin1") !== "MZ") { server.kill(); process.exit(4); }
  console.log("LIBZIP LANE: PASS — PE magic verified"); server.kill(); process.exit(0);
}
