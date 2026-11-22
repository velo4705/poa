/**
 * poa.decompile_native — Ghidra-backed native machine-code decompilation.
 *
 * Runs Ghidra's headless analyzer with a generated Java script that decompiles
 * selected functions to C. Honest limits: the output is Ghidra PSEUDO-C, not
 * port-ready source. It uses Ghidra-specific types (`undefined4`), macros
 * (LOCK/UNLOCK), vtables and calls to undecompiled helpers; making it compile
 * requires a generated compatibility header and human repair per function.
 * POA never claims this yields a working port by itself.
 */
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promises as fs } from "node:fs";
import * as path from "node:path";

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = !error ? 0 : typeof error.code === "number" ? error.code : null;
      resolve({ code, out: String(stdout), err: String(stderr) });
    });
  });
}

async function findGhidra(): Promise<string | null> {
  if (process.env.GHIDRA_INSTALL_DIR) return process.env.GHIDRA_INSTALL_DIR;
  try {
    for (const e of await fs.readdir("/nix/store")) {
      if (!/ghidra-\d/.test(e)) continue;
      const bin = path.join("/nix/store", e, "bin", "ghidra-analyzeHeadless");
      if (await fs.access(bin).then(() => true, () => false)) return path.join("/nix/store", e);
    }
  } catch { /* ignore */ }
  return null;
}

async function findJava(): Promise<string | null> {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  try {
    for (const e of (await fs.readdir("/nix/store")).filter((n) => /openjdk-21/.test(n))) {
      const java = path.join("/nix/store", e, "bin", "java");
      if (await fs.access(java).then(() => true, () => false)) return path.join("/nix/store", e);
    }
  } catch { /* ignore */ }
  return null;
}

export interface NativeDecompilation {
  ok: boolean;
  input: string;
  outputDir: string;
  functions: number;
  files: string[];
  notes: string[];
  blocker?: { what: string; why: string; ask?: string };
  logTail?: string;
}

export async function decompileNative(opts: {
  input: string;
  outputDir: string;
  filter?: string;
  maxFunctions?: number;
}): Promise<NativeDecompilation> {
  const input = path.resolve(opts.input);
  const out = path.resolve(opts.outputDir);
  const notes = ["Ghidra pseudo-C, not compilable port source: Ghidra types/macros/vtables need repair."];
  const empty: NativeDecompilation = { ok: false, input, outputDir: out, functions: 0, files: [], notes };
  const exists = await fs.access(input).then(() => true, () => false);
  if (!exists) return { ...empty, blocker: { what: "no input file", why: `path not found: ${input}` } };

  const ghidra = await findGhidra();
  if (!ghidra) return { ...empty, blocker: { what: "Ghidra not found", why: "set GHIDRA_INSTALL_DIR or install ghidra", ask: "nix shell nixpkgs#ghidra" } };
  const java = await findJava();
  if (!java) return { ...empty, blocker: { what: "Java not found", why: "set JAVA_HOME to a JDK 21+ install" } };

  const scripts = path.join(out, "scripts");
  const decomp = path.join(out, "c");
  await fs.mkdir(scripts, { recursive: true });
  await fs.mkdir(decomp, { recursive: true });
  const filter = opts.filter ?? "";
  const max = Math.max(1, Math.min(opts.maxFunctions ?? 40, 2000));
  const javaScript = `import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.Function;
import java.io.File;
import java.io.PrintWriter;

public class PoaDecompile extends GhidraScript {
  @Override
  public void run() throws Exception {
    File out = new File("${decomp.replace(/\\/g, "/")}");
    out.mkdirs();
    DecompInterface di = new DecompInterface();
    di.openProgram(currentProgram);
    int count = 0;
    for (Function f : currentProgram.getFunctionManager().getFunctions(true)) {
      String name = f.getName();
      if (${JSON.stringify(filter)}.length() > 0 && !name.contains(${JSON.stringify(filter)})) continue;
      if (count >= ${max}) break;
      DecompileResults res = di.decompileFunction(f, 60, monitor);
      if (res != null && res.decompileCompleted()) {
        String c = res.getDecompiledFunction().getC();
        String clean = name.replaceAll("[^A-Za-z0-9_]", "_");
        try (PrintWriter pw = new PrintWriter(new File(out, String.format("%05d_%s.c", count, clean)))) {
          pw.println(c);
        }
        count++;
      }
    }
    println("POA_DECOMPILED=" + count);
  }
}
`;
  const scriptPath = path.join(scripts, "PoaDecompile.java");
  await fs.writeFile(scriptPath, javaScript);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JAVA_HOME: java,
    PATH: `${path.join(java, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const projectDir = path.join(tmpdir(), `poa-ghidra-${Date.now()}`);
  await fs.mkdir(projectDir, { recursive: true });
  const headless = path.join(ghidra, "bin", "ghidra-analyzeHeadless");
  const r = await run(headless, [
    projectDir, "poa-project", "-import", input,
    "-scriptPath", scripts, "-postScript", "PoaDecompile.java", "-deleteProject",
  ], env, 900_000);

  const files = (await fs.readdir(decomp)).filter((f) => f.endsWith(".c")).map((f) => path.join(decomp, f));
  if (r.code !== 0) {
    return { ...empty, files, functions: files.length, logTail: (r.out + "\n" + r.err).slice(-2000),
      blocker: { what: "Ghidra decompilation failed", why: `analyzeHeadless exited with code ${r.code}` } };
  }
  return { ok: true, input, outputDir: out, functions: files.length, files, notes };
}
