/**
 * M2 corpus lane: build Mbed TLS (Apache-2.0) from source via POA — unmodified.
 * Unlike the other lanes, this one requires the recursive submodule fetch
 * (tf-psa-crypto/framework and its own nested submodule) and python3+jinja2+
 * jsonschema (codegen .py scripts), which are now baked into the dev shell.
 *
 *   MBEDTLS_SRC=/path/to/mbedtls   [target=windows-x86_64-mingw]
 *     POA_CMAKE_TOOLCHAIN_FILE=scripts/zig-cross/windows-gnu-toolchain.cmake
 *
 * On Windows (native target): compiles a small PSA-SHA256 verifier against the
 *   built libs and runs it. On Linux: PE magic check only.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = process.env.MBEDTLS_SRC ?? "/tmp/opencode/mbedtls";
const target = process.env.POA_TARGET ?? "windows-x86_64-mingw";
const work = process.env.POA_M2_WORK ?? "/tmp/opencode/m2-mbedtls-work";
const verifier = path.join(repo, "scripts/psa-hash-test.c");
if (!existsSync(path.join(src, "CMakeLists.txt"))) {
  console.error(`Mbed TLS not found at ${src} — clone first (with submodules):`);
  console.error("  git clone https://github.com/Mbed-TLS/mbedtls.git /tmp/opencode/mbedtls");
  console.error("  cd /tmp/opencode/mbedtls && git submodule update --init --recursive");
  process.exit(2);
}
if (!existsSync(path.join(src, "tf-psa-crypto/framework/CMakeLists.txt"))) {
  console.error("Mbed TLS submodules not initialised — run:");
  console.error(`  cd ${src} && git submodule update --init --recursive`);
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
  clientInfo: { name: "m2-mbedtls-driver", version: "0" },
});
console.log("server:", init.result?.serverInfo);
notify("notifications/initialized", {});

await call("poa.start_port", {
  source: src,
  target,
  provenance: "open-source",
  strategy: "cross-compile",
});

// Point cmake at our venv python — its Python3_FIND_STRATEGY LOCATION prefers
// system paths like the brew framework python, which lacks jsonschema.
// Allows the driver to honour POA_PYTHON (or PATH's python3) as the interpreter.
const pyCandidates = process.env.POA_PYTHON
  ? [process.env.POA_PYTHON]
  : (process.platform === "win32"
      ? ["C:\\Program Files\\Python312\\python.exe", "C:\\Program Files\\Python313\\python.exe", "python", "python3"]
      : ["/tmp/poa-mbedtls-venv/bin/python3", "/tmp/poa-mbedtls-venv/bin/python", "python3", "python"]);
let python = null;
for (const c of pyCandidates) {
  try {
    const stdout = execFileSync(c, ["-c", "import jinja2, jsonschema; print('ok')"], { encoding: "utf8", timeout: 10000 });
    if (stdout.trim() === "ok") {
      // Convert command name to absolute path — passing "python" to cmake means
      // cmake re-does its own PATH search and can land on a managed-toolbox python
      // that lacks our deps. Returning an absolute path pins the correct interpreter.
      try {
        python = execFileSync(process.platform === "win32" ? "where.exe" : "which", [c], { encoding: "utf8" })
          .split(/\r?\n/)[0].trim();
      } catch { python = c; }
      break;
    }
  } catch (e) { /* intentional silent-ignore */ }
}
if (!python) {
  console.error("no python with jinja2+jsonschema on PATH found; set POA_PYTHON to override");
  server.kill();
  process.exit(2);
}
console.log("using python:", python);

const build = await call("poa.build", {
  mode: "auto", // native on windows-latest, cross on ubuntu via POA_CMAKE_TOOLCHAIN_FILE
  cmakeArgs: [
    "-DENABLE_PROGRAMS=OFF",
    "-DENABLE_TESTING=OFF",
    "-DGEN_FILES=ON",
    "-DBUILD_SHARED_LIBS=OFF",
    "-DCMAKE_BUILD_TYPE=Release",
    `-DPython3_EXECUTABLE=${python}`,
  ],
});
if (!build.ok) {
  console.log("\nMBEDTLS LANE: BUILD BLOCKED — a finding, not a failure.");
  server.kill();
  process.exit(2);
}
await call("poa.get_report", {});

// Locate the libs under .poa/build/<session-id>/ (session-id is generated by POA)
const { readdirSync } = await import("node:fs");
const buildRoot = path.join(work, ".poa", "build");
const entries = readdirSync(buildRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
if (entries.length === 0) {
  console.error("no build dirs under", buildRoot);
  server.kill();
  process.exit(5);
}
const libRoot = process.env.MBEDTLS_BUILD_DIR ?? path.join(buildRoot, entries[0].name);

const tf = existsSync(path.join(libRoot, "tf-psa-crypto/core/libtfpsacrypto.a"))
  ? path.join(libRoot, "tf-psa-crypto/core/libtfpsacrypto.a") : null;
const mbedX509 = existsSync(path.join(libRoot, "library/libmbedx509.a"))
  ? path.join(libRoot, "library/libmbedx509.a") : null;
const mbedcrypto = existsSync(path.join(libRoot, "library/libmbedcrypto.a"))
  ? path.join(libRoot, "library/libmbedcrypto.a") : null;
const mbedtls = existsSync(path.join(libRoot, "library/libmbedtls.a"))
  ? path.join(libRoot, "library/libmbedtls.a") : null;

if (!tf || !mbedX509 || !mbedcrypto || !mbedtls) {
  console.error("could not locate mbedtls static libs under", libRoot);
  server.kill();
  process.exit(5);
}

// For cross-compiles (Linux → windows-x86_64-mingw) the system cc lacks the
// mingw libs; use the same zig-cc wrapper the toolchain used.
const isWindowsTarget = target.includes("windows") || target.includes("mingw");
const cc = (isWindowsTarget && process.platform !== "win32")
  ? path.join(repo, "scripts", "zig-cross", "x86_64-windows-gnu-cc")
  : (process.env.CC ?? (process.platform === "win32" ? "gcc" : "cc"));

const out = path.join(work, process.platform === "win32" || isWindowsTarget ? "psa-hash-test.exe" : "psa-hash-test");
try {
  execFileSync(cc, [
    "-I", path.join(libRoot, "include"),
    "-I", path.join(libRoot, "tf-psa-crypto/include"),
    "-I", path.join(src, "include"),
    "-I", path.join(src, "tf-psa-crypto/include"),
    "-I", path.join(src, "tf-psa-crypto/drivers/builtin/include"),
    "-I", path.join(src, "tf-psa-crypto/drivers/p256-m"),
    "-I", path.join(src, "tf-psa-crypto/drivers/p256-m/p256-m"),
    "-I", path.join(src, "tf-psa-crypto/drivers/everest/include"),
    "-o", out,
    verifier,
    mbedtls,
    mbedX509,
    mbedcrypto,
    tf,
    ...(isWindowsTarget ? ["-lbcrypt"] : []),
  ], { stdio: "inherit" });
} catch (err) {
  console.error("verifier link failed:", err?.message ?? err);
  server.kill();
  process.exit(6);
}

if (process.platform === "win32") {
  try {
    const stdout = execFileSync(out, [], { encoding: "utf8", timeout: 30000 });
    process.stdout.write(stdout);
    console.log("MBEDTLS LANE: PASS — native windows run");
    server.kill();
    process.exit(0);
  } catch (err) {
    console.error("verifier run failed:", err?.message ?? err);
    server.kill();
    process.exit(4);
  }
} else if (isWindowsTarget) {
  // Cross-compiled windows-x86_64 binary; verify PE magic.
  const { openSync, readSync, closeSync, existsSync } = await import("node:fs");
  const fd = openSync(out, "r");
  const head = Buffer.alloc(2);
  readSync(fd, head, 0, 2, 0);
  closeSync(fd);
  console.log("MBEDTLS PE magic:", JSON.stringify(head.toString("latin1")), "(expect MZ)");
  if (head.toString("latin1") !== "MZ") { server.kill(); process.exit(4); }
  console.log("MBEDTLS LANE: PASS — PE magic verified");
  server.kill();
  process.exit(0);
} else {
  // Native Linux/macOS verifier run
  try {
    const stdout = execFileSync(out, [], { encoding: "utf8", timeout: 30000 });
    process.stdout.write(stdout);
    console.log("MBEDTLS LANE: PASS — native run");
    server.kill();
    process.exit(0);
  } catch (err) {
    console.error("verifier run failed:", err?.message ?? err);
    server.kill();
    process.exit(4);
  }
}
