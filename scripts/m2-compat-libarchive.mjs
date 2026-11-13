/**
 * M2 corpus lane: build libarchive (BSD-licensed) from source via POA's
 * own MCP tools — with zero source modifications.
 *
 * libarchive is the best possible "transparent compat-shim" case: fully C,
 * CMake project, already ships Windows code paths. POA's cross-compilation
 * approach produces a real win32 PE binary from an unmodified repo.
 *
 *   GIT_REPO=libarchive  [target=windows-x86_64-mingw]
 *   POA_CMAKE_TOOLCHAIN_FILE=scripts/zig-cross/windows-gnu-toolchain.cmake
 *
 * On Windows (native target): runs bsdtar --version and asserts exit 0.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = process.env.LIBARCHIVE_SRC ?? "/tmp/opencode/libarchive";
const target = process.env.POA_TARGET ?? "windows-x86_64-mingw";
const work = process.env.POA_M2_WORK ?? "/tmp/opencode/m2-libarchive-work";
if (!existsSync(path.join(src, "CMakeLists.txt"))) {
  console.error(`libarchive not found at ${src} — clone first:`);
  console.error("  git clone --depth 1 https://github.com/libarchive/libarchive.git /tmp/opencode/libarchive");
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
  console.log(text.length > 1500 ? text.slice(0, 1500) + "\n…[truncated]" : text);
  try { return JSON.parse(text); } catch { return text; }
};

const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "m2-libarchive-driver", version: "0" },
});
console.log("server:", init.result?.serverInfo);
notify("notifications/initialized", {});

await call("poa.start_port", {
  source: src,
  target,
  provenance: "open-source",
  strategy: "cross-compile",
});

const build = await call("poa.build", {
  mode: "auto", // native on windows-latest (MSVC), cross on ubuntu (env POA_CMAKE_TOOLCHAIN_FILE)
  cmakeArgs: [
    "-DENABLE_ZLIB=OFF",
    "-DENABLE_BZip2=OFF",
    "-DENABLE_LZMA=OFF",
    "-DENABLE_LZ4=OFF",
    "-DENABLE_ZSTD=OFF",
    "-DENABLE_OPENSSL=OFF",
    "-DENABLE_MD=ON",
    "-DENABLE_MBEDTLS=OFF",
    "-DENABLE_NETTLE=OFF",
    "-DENABLE_LIBB2=OFF",
    "-DENABLE_LZO=OFF",
    "-DENABLE_EXPAT=OFF",
    "-DENABLE_LIBXML2=OFF",
    "-DENABLE_BSDXML=OFF",
    "-DENABLE_CNG=OFF",
    "-DENABLE_PCREPOSIX=OFF",
    "-DENABLE_PCRE2POSIX=OFF",
    "-DENABLE_WIN32_XMLLITE=OFF",
    "-DBUILD_SHARED_LIBS=OFF",
  ],
});
if (!build.ok) {
  console.log("\nLIBARCHIVE LANE: BUILD BLOCKED — a finding, not a failure.");
  server.kill();
  process.exit(2);
}
await call("poa.get_report", {});

const exes = (build.artifacts ?? []).filter((a) => /\.exe$/i.test(a.path));
const bsdtar = exes.find((a) => /bsdtar/i.test(a.path))?.path ?? exes[0]?.path;
console.log("bsdtar candidate:", bsdtar ?? "(none)");
if (process.platform === "win32") {
  const verify = await call("poa.verify", { artifact: bsdtar, args: ["--version"], timeoutMs: 15000 });
  const ok = verify.outcome === "passed";
  console.log(`\nLIBARCHIVE LANE: ${ok ? "PASS — native windows-x86_64 run" : "NATIVE RUN FAIL"}`);
  server.kill();
  process.exit(ok ? 0 : 4);
}
server.kill();
process.exit(0);
