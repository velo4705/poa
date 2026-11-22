#!/usr/bin/env node
/**
 * M3 proof: Windows PE → Linux ELF, binary→binary, via POA tools.
 *
 *   nix develop --command node scripts/m3-winpe-to-linux.mjs
 *
 * Builds a 3 KB Win32 PE from scripts/m3/hello-win32.c (no CRT, no stack
 * protector), lifts its .text with poa.lift, recompiles with poa.recompile,
 * links the resulting object against scripts/m3/win32-shim.c (a 3-function
 * native implementation of the imported kernel32 calls — NOT Wine), runs the
 * Linux ELF and checks the PE's own message appears. Writes a verification
 * report to .poa/conversions/.
 *
 * Scope: this is a per-binary proof for tiny, syscall-free PE code with a few
 * imports. It does not generalize to GUI apps (see docs/PORTABILITY.md).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = process.env.POA_REPO ?? process.cwd();
const work = mkdtempSync(path.join(tmpdir(), "poa-winpe-"));
const out = path.resolve(".poa/conversions");
mkdirSync(out, { recursive: true });
const run = (cmd, args) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let o = "", e = "";
  p.stdout.on("data", (d) => { o += d; }); p.stderr.on("data", (d) => { e += d; });
  p.on("close", (code) => resolve({ code, out: o, err: e }));
});

const pe = path.join(work, "hello-min.exe");
const cc = await run("zig", ["cc", "-target", "x86_64-windows-gnu", "-O2", "-fno-stack-protector", "-fno-builtin", "-fno-pie",
  "-c", path.join(repo, "scripts/m3/hello-win32.c"), "-o", path.join(work, "guest.o")]);
if (cc.code !== 0) { console.error("guest compile failed:", cc.err); process.exit(1); }
const linkPe = await run("zig", ["cc", "-target", "x86_64-windows-gnu", "-nostdlib", "-e", "WinMain",
  "-Wl,--subsystem,windows", path.join(work, "guest.o"), "-lkernel32", "-o", pe]);
if (linkPe.code !== 0) { console.error("PE link failed:", linkPe.err); process.exit(1); }
const sections = await run("objdump", ["-h", pe]);
const line = sections.out.split("\n").find((l) => /\s\.text\s/.test(l));
const fields = line.trim().split(/\s+/);
const textOff = parseInt(fields[5], 16);
const textSize = parseInt(fields[2], 16);
console.log(`guest PE: .text @ 0x${textOff.toString(16)}, ${textSize} bytes`);

const server = spawn(process.execPath, [path.join(repo, "dist/server.js")], { cwd: work });
let buf = "";
const pending = new Map();
let id = 0;
server.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* noise */ }
  }
});
server.stderr.on("data", () => {});
const call = (name, args) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, resolve);
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method: "tools/call", params: { name, arguments: args } }) + "\n");
  setTimeout(() => reject(new Error(`timeout ${name}`)), 120000);
});
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 999, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "winpe-e2e", version: "0" } } }) + "\n");
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

const lift = JSON.parse((await call("poa.lift", { input: pe, output: path.join(work, "pe.bc"), arch: "amd64", os: "windows", range: [textOff, textOff + textSize] })).result.content[0].text);
console.log("poa.lift:", lift.ok, lift.stats);
if (!lift.ok) { console.error(lift); server.kill(); process.exit(1); }
const rec = JSON.parse((await call("poa.recompile", { irPath: lift.irPath, targetArch: "x86_64", targetOs: "linux", output: path.join(work, "pe-linux.o") })).result.content[0].text);
console.log("poa.recompile:", rec.ok, rec.output);
if (!rec.ok) { console.error(rec); server.kill(); process.exit(1); }
server.kill();

const elf = path.join(out, "hello-from-winpe");
const link = await run("zig", ["cc", "-target", "x86_64-linux-musl", "-O2", "-static",
  path.join(repo, "scripts/m3/win32-shim.c"), rec.output, "-o", elf]);
if (link.code !== 0) { console.error("host link failed:", link.err); process.exit(1); }
const result = await run(elf, [pe]);
const expected = "Hello from the M3 spike";
const verified = result.code === 0 && result.out.includes(expected);
console.log("linux ELF:", elf);
console.log("output:", JSON.stringify(result.out.trim()));
console.log(verified ? "VERIFIED: Windows PE code ran natively on Linux (no Wine, no source)" : "FAILED");

const report = {
  flow: "Win32 PE → poa.lift → poa.recompile → Linux ELF + 3-import native shim",
  result: verified ? "VERIFIED" : "FAILED",
  evidence: { peBytes: readFileSync(pe).length, liftedBytes: lift.stats?.bytesLifted, exitCode: result.code, output: result.out.trim() },
  artifacts: { pe, liftedIR: lift.irPath, linuxObject: rec.output, linuxExecutable: elf },
  shim: "scripts/m3/win32-shim.c — 3 kernel32 imports implemented natively; NOT Wine",
  scope: "tiny syscall-free PE code; does not generalize to GUI apps or large import tables",
  verifiedAt: new Date().toISOString(),
};
writeFileSync(path.join(out, "m3-winpe-to-linux.json"), JSON.stringify(report, null, 2));
process.exit(verified ? 0 : 1);
