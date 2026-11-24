# POA — Port Anything

<div align="center">

[![M8ven Score](https://m8ven.ai/badge/mcp/velo4705-poa-1bse7p?v=fbff28b3ebebfc69508fe7fce657bb31)](https://m8ven.ai/mcp/velo4705-poa-1bse7p?s=readme)

</div>

**POA ports software between platforms.** You give it a program — your own
code, an open-source project, a Windows `.exe` — and it produces a build for
whatever target you ask for: Linux from Windows, ARM64 from x86-64, and so on.

It is not an AI that invents ports. Your coding agent does the hard parts;
POA is the set of tools your agent calls to do them honestly and mechanically.

**POA doesn't promise "no quality loss."** It promises the best fidelity the
target allows, with every loss explicit and documented — never hidden.

## What it will and won't do

- ✅ Plan one input against **every target OS/arch** (`poa.port_matrix`) — see [Any OS → Any OS](docs/ANY-OS.md)
- ✅ Port C/C++ **source** to another OS or architecture (same code, new build)
- ✅ Cross-compile from Linux to Windows via a clean toolchain (`zig cc`)
- ✅ Verify a port runs, using the target's own tests or a native/qemu smoke run
- ✅ Report exactly what didn't make it, so humans decide what to chase
- ✅ Keep trying: `poa.next_attempt` turns any blocker into three genuinely different next approaches ([motivation](docs/POA-MOTIVATION.md))
- ✅ Lift a syscall-free binary function to another ISA and **run it there** (verified: x86-64 → aarch64 via `poa.lift` + `poa.recompile` + a small host shim)
- ✅ Convert a small Windows PE (3 kernel32 imports) to a **running Linux ELF** via POA tools + a per-binary native shim — no Wine, no source
- ❌ Lift a binary to a different platform by magic — POA refuses to pretend; `poa.assess_portability` shows exactly where the possible→impossible ladder stops
- ❌ Bypass DRM, anti-cheat, or platform licensing — it's out of scope, firmly

## Who this is for

- You maintain software and want to ship it on another platform without
  rewriting it.
- You want your coding agent to attempt a port and tell you what worked, what
  didn't, and what needs a human — in one pass, not a month of diffs.
- You want the gaps documented, not guessed at.

## Quick start

Requirements: Node ≥ 18. On Linux, `nix develop` gives you a working dev
shell (node, cmake, ninja, qemu-user, zig — all binary-cached); on other
OSes, bring your own.

```sh
npm install
npm run build
node scripts/smoke.mjs     # end-to-end sanity test of the MCP server
```

Wire it into your MCP client. For OpenCode, copy `opencode.example.json` to
`opencode.json`, point it at this repo's `dist/server.js`, and restart:

```json
{ "mcp": { "poa": { "type": "local", "command": ["node", "/path/to/poa/dist/server.js"] } } }
```

Ask your agent: *"try to port this project to windows-x86_64-mingw and report
what breaks."* Watch the log and the port report together.

## How it works

```
┌────────────┐    ┌────────────┐    ┌────────────┐
│  Ingest it │ →  │  Plan it   │ →  │  Build &   │
│  classifies│    │  maps what │    │  run it     │
│  ELF / PE  │    │  breaks    │    │  verifies   │
│  or source │    │  honestly  │    │  artifacts  │
└────────────┘    └────────────┘    └────────────┘
```

Your agent drives the three steps — classifying what you gave it, mapping
what it needs vs. what your target offers, and building & running it — then
reads the port report POA prints. POA rejects fake completions:

- If the build fails, it says so.
- If a degradation is unavoidable, it makes you declare it explicitly.
- If something needs a human, it stops and asks one structured question.

## Legal scope

POA operates on software **you have the right to port**: your own code,
open-source software, or software you're licensed to modify and redistribute.
POA is not a circumvention tool. It will never remove DRM, bypass anti-cheat,
or confer rights you don't have.

## The fine print

- **Source → binary**: POA compiles it. The result is as good as your source and your build.
- **Binary → binary**: POA recompiles what it can, refuses to fake the rest.
- **Cross-compile**: POA uses the best available cross-toolchain (zig cc),
  with declared PE/Mach-O/ELF output verification.

Quality claims are made by POA's own tests, your own test suite, or the
project you port — not by POA's marketing.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). License: MIT OR Apache-2.0, at your choice.
See [LICENSE-MIT](LICENSE-MIT) and [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0).

## Using POA — more depth

[USAGE.md](docs/USAGE.md) has the full walkthrough: sessions, registries,
multi-project workflows, and concurrency. [ROADMAP.md](docs/ROADMAP.md)
describes what's built, what's next, and what explicitly isn't promised.
