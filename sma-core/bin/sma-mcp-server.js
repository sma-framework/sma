#!/usr/bin/env node
'use strict';
/**
 * sma-mcp-server — companion MCP server bin entry (ADR-1239 Phase C-2 / #1681).
 *
 * Lives at top-level bin/ (alongside install.js) — it is a PACKAGE bin the host
 * spawns via `npx sma-mcp-server` (or the global bin), NOT a per-runtime
 * artifact copied into a host's config dir. (Placing it under sma-core/bin/
 * would leak it into every runtime install + break golden parity.)
 *
 * A stdio JSON-RPC 2.0 server exposing SMA interface points 1 (command) + 5
 * (state IO) so any MCP-consuming host (Claude/Codex/OpenCode/VS Code/Gemini/
 * Cursor/Cline/Hermes) can drive SMA with no bespoke plugin. Delegates to the
 * tested server module (sma-core/bin/lib/mcp-server.cjs runServer). Reads
 * line-delimited JSON-RPC from stdin, writes one response + newline per
 * request, exits cleanly when stdin closes.
 *
 * The protocol logic (handleMessage) + the injectable-stream loop (runServer)
 * are unit-tested in tests/sma-mcp-server.test.cjs; the process lifecycle
 * (spawn → JSON-RPC → clean exit) in tests/sma-mcp-server-bin.test.cjs.
 */
const { runServer } = require('../sma-core/bin/lib/mcp-server.cjs');

runServer({
  input: process.stdin,
  output: process.stdout,
  ctx: { cwd: process.cwd() },
}).catch((err) => {
  process.stderr.write(String((err && err.message) || err) + '\n');
  process.exit(1);
});
