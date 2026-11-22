/**
 * poa.convert_wpf_to_avalonia — source-to-source port of decompiled WPF C#.
 *
 * Copies a decompiled .NET project, maps System.Windows.* namespaces to
 * Avalonia equivalents, injects generated source-level declarations for
 * WPF-only types/event args, and writes a net8.0 Avalonia project skeleton
 * with a minimal app entry point. This is a starting point for a real port,
 * NOT a completed port: the original BAML views are not recovered, the
 * generated stubs preserve signatures only, and the build almost certainly
 * needs per-API repair. POA reports exactly that rather than claiming success.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const NS_MAP: Array<[string, string]> = [
  ["System.Windows.Threading", "Avalonia.Threading"],
  ["System.Windows.Controls.Primitives", "Avalonia.Controls.Primitives"],
  ["System.Windows.Media.Imaging", "Avalonia.Media.Imaging"],
  ["System.Windows.Interop", "Avalonia.Interop"],
  ["System.Windows.Documents", "Avalonia.Documents"],
  ["System.Windows.Navigation", "Avalonia.Navigation"],
  ["System.Windows.Controls", "Avalonia.Controls"],
  ["System.Windows.Media", "Avalonia.Media"],
  ["System.Windows.Shapes", "Avalonia.Controls.Shapes"],
  ["System.Windows.Input", "Avalonia.Input"],
  ["System.Windows.Data", "Avalonia.Data"],
  ["System.Windows.Markup", "Avalonia.Markup.Xaml"],
  ["System.Windows.Forms", "Avalonia.Controls"],
  ["System.Windows", "Avalonia"],
];

export interface WpfConversion {
  ok: boolean;
  input: string;
  outputDir: string;
  filesCopied: number;
  namespacesMapped: number;
  notes: string[];
  blocker?: { what: string; why: string };
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "obj" && e.name !== "bin") yield* walk(p); }
    else yield p;
  }
}

export async function convertWpfToAvalonia(opts: { input: string; outputDir: string }): Promise<WpfConversion> {
  const input = path.resolve(opts.input);
  const out = path.resolve(opts.outputDir);
  const notes = [
    "BAML views were not recovered; InitializeComponent() is stubbed and the UI is blank.",
    "Generated WPF type declarations preserve signatures only — they are not behaviour.",
    "The native engine P/Invoke surface is untouched; no Linux engine implementation is produced.",
    "Run poa.build on the output to measure the remaining compile errors honestly.",
  ];
  if (!(await fs.stat(input).then(() => true, () => false))) {
    return { ok: false, input, outputDir: out, filesCopied: 0, namespacesMapped: 0, notes, blocker: { what: "input not found", why: input } };
  }
  const templateDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "conversion", "wpf-avalonia");
  await fs.mkdir(out, { recursive: true });

  let files = 0;
  let mapped = 0;
  for await (const f of walk(input)) {
    const rel = path.relative(input, f);
    const dest = path.join(out, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (f.endsWith(".csproj")) continue;
    let text = await fs.readFile(f, "utf8");
    if (f.endsWith(".cs")) {
      // Decompiler artifacts that block any build, fixed mechanically.
      text = text.replace(/\(\([A-Za-z_][A-Za-z0-9_.<>]*\)\(ref ([A-Za-z_][A-Za-z0-9_]*)\)\)\./g, "$1.");
      text = text.replace(/Resources\.LZD_/g, "Properties.Resources.LZD_");
      text = text.replace(/\bResources\.Culture\b/g, "EMP_MPP.Properties.Resources.Culture");
      text = text.replace(/\(\(Window\)this\)\.(On[A-Za-z]+)\(/g, "base.$1(");
      text = text.replace(/DataGridLength\.op_Implicit\(/g, "new DataGridLength(");
      text = text.replace(/ManagementObjectEnumerator enumerator/g, "ManagementObjectCollection.ManagementObjectEnumerator enumerator");
      text = text.replace(/Screen\.PrimaryScreen/g, "System.Windows.Forms.Screen.PrimaryScreen");
      text = text.replace(/Screen\[\] allScreens = Screen\.AllScreens;/g, "System.Windows.Forms.Screen[] allScreens = System.Windows.Forms.Screen.AllScreens;");
      text = text.replace(/foreach \(Screen obj in allScreens\)/g, "foreach (System.Windows.Forms.Screen obj in allScreens)");
      text = text.replace(/Keyboard\.GetKeyStates\((\(Key\)\d+)\) & 1/g, "((int)Keyboard.GetKeyStates($1) & 1)");
      text = text.replace(/Keyboard\.Modifiers & 2/g, "((int)Keyboard.Modifiers & 2)");
      text = text.replace(/\(val2 - 1\) switch/g, "((int)val2 - 1) switch");
      text = text.replace(/\[assembly: ThemeInfo\([^\n]*\)\]\n/g, "");
      for (const [from, to] of NS_MAP) {
        const needle = `using ${from};`;
        if (text.includes(needle)) { mapped += text.split(needle).length - 1; text = text.split(needle).join(`using ${to};`); }
      }
      text = text.replace(/using Avalonia\.Interop;\n/g, "").replace(/using Avalonia\.Documents;\n/g, "").replace(/using Avalonia\.Navigation;\n/g, "");
      text = text.replace(/\[assembly: ThemeInfo\([^\n]*\)\]\n/g, "");
    }
    await fs.writeFile(dest, text);
    files++;
  }

  for (const name of ["Compat.cs", "Stubs2.cs", "Program.cs", "App.cs"]) {
    await fs.copyFile(path.join(templateDir, name), path.join(out, name));
    files++;
  }
  await fs.copyFile(path.join(templateDir, "csproj.template"), path.join(out, "EMP_MPP.csproj"));
  return { ok: true, input, outputDir: out, filesCopied: files, namespacesMapped: mapped, notes };
}
