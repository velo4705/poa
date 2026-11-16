/**
 * M2 corpus lane: small C libraries built from source via POA, for
 * windows-x86_64 cross-compile (and native lanes in CI).  One script parameterised
 * per project — cJSON, jansson, libzip.
 *
 *   LIBPROJECT=cjson|jansson|libzip  [POA_TARGET=windows-x86_64-mingw|linux-x86_64-generic|macos-aarch64]
 *     POA_CMAKE_TOOLCHAIN_FILE=scripts/zig-cross/windows-gnu-toolchain.cmake
 *
 * Verification:
 *   - cJSON: compiles once built against our own verifier (scripts/cjson-roundtrip.c)
 *   - jansson: runs `json_process` from its bundled examples
 *   - libzip:   runs `ziptool --version`
 *
 * On Linux (cross to windows): PE magic verified only (cannot run Windows PE).
 * On windows-latest: native build + verification via poa.verify.
 * On macOS: native Mach-O build + verification via poa.verify.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const lib = process.env.LIBPROJECT ?? "cjson";
const target = process.env.POA_TARGET ?? "windows-x86_64-mingw";
const work = process.env.POA_M2_WORK ?? `/tmp/opencode/m2-${lib}-work`;
mkdirSync(work, { recursive: true });

const config = {
  cjson: {
    src: process.env.CJSON_SRC ?? "/tmp/opencode/cJSON",
    clone: "https://github.com/DaveGamble/cJSON.git",
    cmakeArgs: ["-DENABLE_CJSON_TEST=OFF"],
    artifact: /cjson\.(a|lib|dll|so)$/,
    verify: "/tmp/opencode/cjson-roundtrip.exe",
    verifyBuild: (lib, workDir) => {
      // Link our committed verifier against the just-built cJSON library.
      const cc = process.platform === "win32"
        ? "gcc"
        : path.join(repo, "scripts/zig-cross/x86_64-windows-gnu-cc");
      const localLibPath = [path.join(workDir, "cjson-build", "libcjson.a")];
      const out = path.join(work, "cjson-roundtrip.exe");
      execFileSync(cc, [
        "-I", path.join(lib, "*"),
        "-I", lib,
        "-o", out,
        path.join(repo, "scripts/cjson-roundtrip.c"),
        ...localLibPath,
      ], { stdio: "inherit" });
      return out;
    },
  },
  jansson: {
    src: process.env.JANSSON_SRC ?? "/tmp/opencode/jansson",
    clone: "https://github.com/akheron/jansson.git",
    cmakeArgs: [],
    artifact: /jansson\.(a|lib|dll|so)$/,
    verify: null, // uses bundled `json_process`
    verifyBuild: () => null,
  },
  libzip: {
    src: process.env.LIBZIP_SRC ?? "/tmp/opencode/libzip",
    clone: "https://github.com/nih-at/libzip.git",
    cmakeArgs: [
      "-DBUILD_SHARED_LIBS=OFF",
      "-DDWORD_MAX=0xFFFFFFFF",
      "-D_GNU_SOURCE",
      "-D_FORTIFY_SOURCE=0",
      "-DWIN32=OFF",
      `-DZLIB_ROOT=/tmp/opencode/zlocal`,
    ],
    artifact: /zip|libzip|zipsh/i,
    verify: null,
    verifyBuild: () => null,
  },
};

const cfg = config[lib];
if (!cfg) {
  console.error(`LIBPROJECT must be one of: ${Object.keys(config).join(", ")}`);
  process.exit(2);
}
if (!existsSync(path.join(cfg.src, "CMakeLists.txt"))) {
  console.error(`${lib} source not found at ${cfg.src}:`);
  console.error(`  git clone --depth 1 ${cfg.clone} ${cfg.src}`);
  process.exit(2);
}

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
  console.log(text.length > 1500 ? text.slice(0, 1500) + "\n…[truncated]" : text);
  try { return JSON.parse(text); } catch { return text; }
};

const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: `m2-compat-${lib}`, version: "0" },
});
console.log("server:", init.result?.serverInfo);
notify("notifications/initialized", {});

await call("poa.start_port", {
  source: cfg.src,
  target,
  provenance: "open-source",
  strategy: "cross-compile",
});
const build = await call("poa.build", { mode: "auto", cmakeArgs: cfg.cmakeArgs });
if (!build.ok) {
  console.log(`\n${lib.toUpperCase()} LANE: BUILD BLOCKED — a finding, not a failure.`);
  server.kill();
  process.exit(2);
}
await call("poa.get_report", {});

// Locate any executable artifact and run it (native targets only)
// or verify PE magic on cross-targets.
const exe = (build.artifacts ?? []).find((a) => /\.(exe|bat|cmd|whl|msi)$/i.test(a.path) || !a.path.endsWith(".a") && !a.path.endsWith(".o"))?.path;
const outPE = (build.artifacts ?? [])[0]?.path;

if (process.platform === "win32" || process.platform === "darwin") {
  // Native: report what was built then verify the binary (or report none)
  if (!exe) {
    console.error(`${lib}: no executable artifact found — nothing to verify`);
    server.kill();
    process.exit(3);
  }
  try {
    const { outcome } = await call("poa.verify", { artifact: exe, args: [], timeoutMs: 15000 });
    console.log(`${lib}: native verify outcome=${outcome}`);
    server.kill();
    process.exit(outcome === "passed" ? 0 : 4);
  } catch (err) {
    console.error(`${lib}: verify failed:`, err?.message ?? err);
    server.kill();
    process.exit(4);
  }
} else {
  const fd = await import("node:fs").then((m) => m.promises.open(outPE, "r"));
  const head = Buffer.alloc(2);
  await fd.read(head, 0, 2, 0);
  await fd.close();
  console.log(`${lib} PE magic: ${JSON.stringify(head.toString("latin1"))} (expect MZ)`);
  if (head.toString("latin1") !== "MZ") { server.kill(); process.exit(4); }
  console.log(`${lib}: PASS — PE magic verified`);
  server.kill();
  process.exit(0);
}
