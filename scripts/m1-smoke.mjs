/**
 * M1/M2 smoke test for the actual PORT — not a --version sanity check.
 *
 * Builds Chocolate DOOM for aarch64-linux-musl via POA's own tools, then runs a
 * full gameplay demo (Freedoom DEMO1) under qemu-user with dummy SDL drivers.
 * Demo completion + exit 0 = the ARM64 port executes real frames without crashing.
 *
 * Prereqs:
 *   - chocolate-doom cloned to $DOOM_SRC (default /tmp/opencode/chocolate-doom)
 *   - Freedoom's freedoom2.wad at $WAD (default /tmp/opencode/freedoom-0.13.0/freedoom2.wad)
 *
 *   nix develop --command node scripts/m1-smoke.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const doom = process.env.DOOM_SRC ?? "/tmp/opencode/chocolate-doom";
const wad = process.env.WAD ?? "/tmp/opencode/freedoom-0.13.0/freedoom2.wad";
const work = process.env.POA_M1_WORK ?? "/tmp/opencode/m1-smoke-work";
const K = (process.env.POA_M1_KEEP ?? "1") === "1";
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
  clientInfo: { name: "m1-smoke", version: "0" },
});
console.log("server:", init.result?.serverInfo);
notify("notifications/initialized", {});

await call("poa.start_port", {
  source: doom,
  target: "linux-aarch64-generic",
  provenance: "open-source",
  strategy: "cross-compile",
});
await call("poa.choose_strategy", {});

const build = await call("poa.build", {
  mode: "cross",
  cmakeArgs: ["-DENABLE_SDL2_MIXER=OFF", "-DENABLE_SDL2_NET=OFF"],
});
if (!build.ok) {
  console.log("\nM1 SMOKE: BUILD BLOCKED — environment changed? Re-check nix develop outputs.");
  server.kill();
  process.exit(2);
}

const exe = (build.artifacts ?? []).find((a) => /chocolate-doom$/.test(a.path))?.path;
console.log("doom exe:", exe);

const verify = await call("poa.verify", {
  artifact: exe,
  args: ["-iwad", wad, "-timedemo", "DEMO1", "-nosound", "-nomusic", "-window"],
  timeoutMs: 60000,
  env: { SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
});
// Chocolate Doom reports a completed -timedemo by raising I_Error() — the
// timing line IS the success signal (src/doom/g_game.c: G_CheckDemoStatus →
// I_Error). Exit 255 is the engine's deliberate completion path, not a crash.
// Behavioral evidence wins over exit codes: "timed NNN gametics" = demo played.
const timedMatch = (verify.logTail ?? "").match(/timed\s+(\d+)\s+gametics\s+in\s+(\d+)\s+realtics\s+\(([\d.]+)\s*fps\)/);
const pass = timedMatch !== null || verify.outcome === "passed";
console.log(`\nM1 SMOKE: ${pass
  ? `PASS — DOOM played DEMO1 to completion under qemu-user on aarch64` +
    (timedMatch ? ` (${timedMatch[1]} gametics, ${timedMatch[3]} fps)` : "")
  : `verify outcome = ${verify.outcome} — see logTail`}`);
if (pass && !K) {
  server.kill();
  process.exit(0);
}
server.kill();
process.exit(pass ? 0 : 3);
