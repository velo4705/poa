#!/usr/bin/env node
/**
 * poa-mcp: the POA (Port Anything) MCP server.
 *
 * POA turns software binaries and source into ports for other devices.
 * This server exposes the pipeline as MCP tools so an agent can drive it:
 *
 *   poa.list_targets    — enumerate known target devices
 *   poa.scout_target    — full profile of one target
 *   poa.inspect_input   — byte-level classification of a binary/source/firmware image
 *   poa.plan_port       — run ingest → scout → discrepancy map, emit a port report
 *
 * Honesty contract: no tool fakes a completed port. The translation engine
 * does not exist yet (docs/ROADMAP.md); plan_port reports exactly which
 * gaps are automatic, which need an adapter, and which need a human.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TARGETS, findTarget } from "./targets.js";
import { ingest } from "./manifest.js";
import { mapDiscrepancies } from "./discrepancy.js";
import type { PortReport } from "./report.js";

const VERSION = "0.1.0";

const server = new McpServer({ name: "poa", version: VERSION });

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

server.registerTool(
  "poa.list_targets",
  {
    title: "List POA targets",
    description:
      "List all built-in target device profiles POA knows about (arch, OS, RAM, GPU, input, formats).",
    inputSchema: {},
  },
  async () =>
    json(
      TARGETS.map((t) => ({
        id: t.id,
        description: t.description,
        arch: t.arch,
        os: t.os,
      })),
    ),
);

server.registerTool(
  "poa.scout_target",
  {
    title: "Scout a target",
    description:
      "Return the full static profile of one target device: arch, OS, RAM budget, GPU class, inputs, display, accepted binary formats. First stage of the POA agent loop.",
    inputSchema: { target: z.string().describe("Target id, e.g. 'linux-aarch64-generic'") },
  },
  async ({ target }) => {
    const profile = findTarget(target);
    if (!profile) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Unknown target '${target}'. Known targets: ${TARGETS.map((t) => t.id).join(", ")}`,
          },
        ],
      };
    }
    return json(profile);
  },
);

server.registerTool(
  "poa.inspect_input",
  {
    title: "Inspect a port candidate",
    description:
      "Classify an input file (ELF / PE / Mach-O / WASM / ZIP / raw firmware / source tree) and emit a Port Manifest: kind, arch, bits, endianness, platform hint, confidence, and explicit unknowns. Byte-level detection; no guessing.",
    inputSchema: {
      path: z.string().describe("Absolute or relative path to the input file or source directory"),
    },
  },
  async ({ path: inputPath }) => {
    try {
      return json(await ingest(inputPath));
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Ingest failed: ${(err as Error).message}` }],
      };
    }
  },
);

server.registerTool(
  "poa.plan_port",
  {
    title: "Plan a port",
    description:
      "Run stages 1–3 of the POA agent loop (scout, ingest, discrepancy map) for an input and a target, and emit a machine-readable port report. Does NOT produce the ported artifact yet — the translation engine is not built (see docs/ROADMAP.md). The report states exactly what is automatic, what needs an adapter, and what needs a human.",
    inputSchema: {
      source: z.string().describe("Path to the input binary, source tree, or firmware image"),
      target: z.string().describe("Target id, e.g. 'linux-aarch64-generic'"),
      out: z
        .string()
        .optional()
        .describe("Optional file path to write the port report JSON to (e.g. '.poa/report.json')"),
    },
  },
  async ({ source, target, out }) => {
    const profile = findTarget(target);
    if (!profile) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Unknown target '${target}'. Known targets: ${TARGETS.map((t) => t.id).join(", ")}`,
          },
        ],
      };
    }

    let manifest;
    try {
      manifest = await ingest(source);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Ingest failed: ${(err as Error).message}` }],
      };
    }

    const discrepancies = mapDiscrepancies(manifest, profile);

    const report: PortReport = {
      tool: "poa",
      version: VERSION,
      source: path.resolve(source),
      target: profile.id,
      status: "blocked",
      manifest,
      discrepancies,
      blockers: [
        {
          stage: "translate",
          what: "translation engine not implemented",
          why: "POA is at M0/M1; the lift-to-IR / cross-compile / adapter layers are not built yet.",
          ask: "Implement M1 (source → ARM64 Linux) and this report becomes a real build.",
        },
      ],
      degraded: {},
      generatedAt: new Date().toISOString(),
    };

    if (out) {
      const abs = path.resolve(out);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, JSON.stringify(report, null, 2));
    }

    return json(report);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`poa-mcp ${VERSION} ready (stdio)`);
