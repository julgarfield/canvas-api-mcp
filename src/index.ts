#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CanvasError, logError } from "./errors.js";
import { buildServer } from "./server.js";

// stdout is reserved for MCP JSON-RPC. Route stray console output to stderr.
console.log = (...args: unknown[]) => logError(args.map(String).join(" "));
console.info = console.log;
console.warn = console.log;
console.debug = console.log;

async function main() {
  try {
    const { server, config, tools } = buildServer();
    await server.connect(new StdioServerTransport());
    logError(`ready (origin ${config.origin}, ${tools.length} read-only tools)`);
  } catch (err) {
    logError(err instanceof CanvasError ? err.message : `failed to start: ${(err as Error)?.message ?? err}`);
    process.exit(1);
  }
}

process.on("unhandledRejection", (e) => logError(`unhandled rejection: ${(e as Error)?.message ?? e}`));
main();
