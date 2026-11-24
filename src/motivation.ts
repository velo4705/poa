/**
 * poa.next_attempt — the "never stop porting" loop, made executable.
 *
 * POA does not accept "impossible" as an answer to a porting goal. It accepts
 * only specific, evidenced blockers. This tool turns a blocker into the next
 * concrete experiments: reframe the goal, list genuinely different mechanisms
 * (not parameter tweaks), and name the smallest verifiable step for each.
 *
 * It is deliberately honest: a real stop is allowed only for a missing
 * credential/permission/rights, an explicit user constraint, a proven physical
 * or mathematical limit, or an irreversible action requiring approval.
 */

export interface Attempt {
  approach: string;
  mechanism: string;
  smallestStep: string;
  evidenceThatWouldProveIt: string;
}

export interface NextAttempt {
  neverStop: true;
  goal: string;
  blocker: string;
  reframe: string;
  attempts: Attempt[];
  forbiddenStops: string[];
  genuineStopConditions: string[];
  rule: string;
}

const MOVES: Attempt[] = [
  {
    approach: "Decompose the goal",
    mechanism: "Split the binary into independently portable pieces (UI shell, engine, installer, assets) and port the smallest piece that can be verified.",
    smallestStep: "Pick one exported function or one resource blob and produce a runnable artifact for it.",
    evidenceThatWouldProveIt: "A target-native file that can be executed or loaded, with measured output.",
  },
  {
    approach: "Change representation",
    mechanism: "Move from machine code to IL/C#/pseudo-C, or from binary translation to protocol reimplementation, instead of retrying the same lifter.",
    smallestStep: "Decompile one function or recover one asset and check whether its semantics survive in the new representation.",
    evidenceThatWouldProveIt: "Recovered source/asset that compiles or matches a byte-level digest.",
  },
  {
    approach: "Search prior art",
    mechanism: "Look for existing source, specs, protocol documentation, or SDKs that describe the same behaviour — without adopting a compatibility layer.",
    smallestStep: "Find one authoritative spec or source file and quote the exact API/behaviour it defines.",
    evidenceThatWouldProveIt: "A cited source or spec plus a dependency map into the target platform.",
  },
  {
    approach: "Remove an assumption",
    mechanism: "Drop a feature (drivers, GPU effects, WebRTC) that blocks the whole port and deliver the rest with an explicit degradation declaration.",
    smallestStep: "Build the app without the blocking feature and list the degradation in the port report.",
    evidenceThatWouldProveIt: "A runnable binary plus a declared DEGRADED item — never a silent drop.",
  },
  {
    approach: "Build a minimal experiment",
    mechanism: "Isolate the single risky assumption (e.g. can a 3-import PE be lifted and run?) in a tiny fixture before scaling.",
    smallestStep: "Compile a 10-line fixture, run the tool chain end to end, record the exit code.",
    evidenceThatWouldProveIt: "Observed exit code/output from the target platform.",
  },
  {
    approach: "Change the tool",
    mechanism: "Switch the decompiler/lifter/compiler/UI toolkit rather than re-running a failing invocation with different flags.",
    smallestStep: "Run one alternative tool on the same input and compare its output structure.",
    evidenceThatWouldProveIt: "A different artifact type (e.g. pseudo-C vs IR) with measurable coverage.",
  },
  {
    approach: "Use an analogy",
    mechanism: "Borrow the conversion pattern from a neighbouring domain (Wails→WebKitGTK, MFC→GTK/Avalonia, COM→D-Bus).",
    smallestStep: "Map one Windows API to its target-native equivalent and compile a call site.",
    evidenceThatWouldProveIt: "A target-native call that compiles and runs.",
  },
];

function keywordAttempts(blocker: string): Attempt[] {
  const b = blocker.toLowerCase();
  const out: Attempt[] = [];
  if (/wpf|presentationframework|windows\.windows|baml/.test(b)) out.push({
    approach: "Rewrite the UI against a target-native toolkit",
    mechanism: "WPF has no Linux implementation. Convert XAML/BAML and code-behind to Avalonia or GTK — a source rewrite, not a shim.",
    smallestStep: "Port one window's layout and one command binding to the target toolkit.",
    evidenceThatWouldProveIt: "A window that opens on the target desktop with the same control's behaviour.",
  });
  if (/import|kernel32|user32|dll|abi|shim/.test(b)) out.push({
    approach: "Implement the narrow import surface natively",
    mechanism: "Inventory the exact DLL functions used; implement only those on the target OS as a target-native library (not Wine).",
    smallestStep: "Implement one imported function and call it from a converted binary.",
    evidenceThatWouldProveIt: "The converted binary links, runs and produces the expected value.",
  });
  if (/source|rights|licen|no source/.test(b)) out.push({
    approach: "Recover source from the artifact or request rights-holder input",
    mechanism: "Use IL decompilation, native pseudo-C, or an authoritative protocol spec derived from the binary — and ask for the missing source explicitly.",
    smallestStep: "Recover one faithful source file and record its origin/provenance.",
    evidenceThatWouldProveIt: "A compilable file whose API matches a symbol observed in the binary.",
  });
  if (/build|error|compile/.test(b)) out.push({
    approach: "Fix the build error by dependency conversion, not by suppressing it",
    mechanism: "Map each failing Windows type/API to a target-native equivalent and re-run poa.build.",
    smallestStep: "Resolve the most frequent error category and rebuild.",
    evidenceThatWouldProveIt: "Error count drops and poa.build exits 0.",
  });
  return out;
}

export function nextAttempt(input: { goal: string; blocker: string; tried?: string[] }): NextAttempt {
  const goal = input.goal || "port this input to the requested target";
  const blocker = input.blocker || "unspecified blocker";
  const tried = new Set((input.tried ?? []).map((t) => t.toLowerCase()));
  const targeted = keywordAttempts(blocker);
  const pool = [...targeted, ...MOVES].filter((a, i, arr) => arr.findIndex((x) => x.approach === a.approach) === i);
  const fresh = pool.filter((a) => ![...tried].some((t) => a.approach.toLowerCase().includes(t) || t.includes(a.approach.toLowerCase())));
  const attempts = (fresh.length >= 3 ? fresh : pool).slice(0, 6);
  return {
    neverStop: true,
    goal,
    blocker,
    reframe: `"Cannot do X" is not a blocker. Name the exact mechanism that failed, then find a different mechanism for the same goal.`,
    attempts,
    forbiddenStops: [
      "This binary is proprietary / hard / GUI — therefore impossible.",
      "The lifter failed once — therefore binary translation cannot work.",
      "A substitute exists on the internet — use it instead of porting.",
      "Wine runs it — therefore the port is done.",
    ],
    genuineStopConditions: [
      "a credential, permission, or source rights are genuinely missing",
      "the user explicitly forbids the only viable mechanism",
      "a physical or mathematical limit is proven with evidence",
      "the next action is irreversible and needs human approval",
    ],
    rule: "Three genuinely different approaches is the floor, not the limit. Verify with observable evidence; never claim a port without a runnable artifact.",
  };
}
