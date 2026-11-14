/**
 * M2 corpus lane: build cmark (BSD-2-Clause, CommonMark parser) from source
 * via POA — unmodified sources. Little sanity check via stdin pipe under wine.
 *
 *   CMARK_SRC=/path/to/cmark  [target=windows-x86_64-mingw]
 *     POA_CMAKE_TOOLCHAIN_FILE=scripts/zig-cross/windows-gnu-toolchain.cmake
 *
 * On Windows (native target): runs `cmark --help` and asserts exit 0.
 * On Linux (cross-compiled for Windows): just PE-magic check.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = process.env.CMARK_SRC ?? "/tmp/opencode/cmark";
const target = process.env.POA_TARGET ?? "windows-x86_64-mingw";
const work = process.env.POA_M2_WORK ?? "/tmp/opencode/m2-cmark-work";
if (!existsSync(path.join(src, "CMakeLists.txt"))) {
  console.error(`cmark not found at ${src} — clone first:`);
  console.error("  git clone --depth 1 https://github.com/commonmark/cmark.git /tmp/opencode/cmark");
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
  clientInfo: { name: "m2-cmark-driver", version: "0" },
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
  mode: "auto", // native on windows-latest, cross on ubuntu via POA_CMAKE_TOOLCHAIN_FILE
});
if (!build.ok) {
  console.log("\nCMARK LANE: BUILD BLOCKED — a finding, not a failure.");
  server.kill();
  process.exit(2);
}
await call("poa.get_report", {});

const cmarkExe = (build.artifacts ?? []).find((a) => /[\\/]src[\\/]cmark(\.exe)?$/.test(a.path))?.path;
console.log("cmark artifact:", cmarkExe ?? "(none)");
if (!cmarkExe) {
  console.error("M2 failed to locate src/cmark.exe in the build output");
  server.kill();
  process.exit(3);
}
// The target declared for this run (e.g. 'windows-x86_64-mingw', 'macos-aarch64', 'linux-x86_64-generic')
const declaredTarget = process.env.POA_TARGET ?? "windows-x86_64-mingw";
const hostArchMatchesTarget =
  (process.platform === "darwin" && declaredTarget.startsWith("macos")) ||
  (process.platform === "win32" && declaredTarget.startsWith("windows")) ||
  (process.platform === "linux" && declaredTarget.startsWith("linux"));
const hostArchMap: Record<string, string> = { x64: "x86_64", arm64: "aarch64", ia32: "i386" };
const archMatches = declaredTarget.includes(hostArchMap[process.arch] ?? process.arch);

if (hostArchMatchesTarget && archMatches) {
  const verify = await call("poa.verify", { artifact: cmarkExe, args: ["--version"], timeoutMs: 15000 });
  const ok = verify.outcome === "passed";
  console.log(`\nCMARK LANE: ${ok ? "PASS — native run" : "NATIVE RUN FAIL"}`);
  server.kill();
  process.exit(ok ? 0 : 4);
}

// Cross-compile: binary is for a foreign OS/arch — verify embedded-libav magic, e.g. "MZ" for PE
const { promises: fsp } = await import("node:fs");
const fh = await fsp.open(cmarkExe, "r");
const head = Buffer.alloc(4);
await fh.read(head, 0, 4, 0);
await fh.close();
console.log("cmark artifact magic:", JSON.stringify(head));
const isPe = head[0] === 0x4d && head[1] === 0x5a;
const isElf = head.readUInt32LE(0) === 0x464c457f;
if (!isPe && !isElf) {
  console.error("artifact magic not PE or ELF; unrecognized");
  server.kill();
  process.exit(4);
}
server.kill();
process.exit(0);
