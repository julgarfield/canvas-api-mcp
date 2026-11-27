/**
 * MCP client smoke test over real stdio: spawns the built server, lists tools,
 * and calls canvas_server_info. Does not require (or use) a Canvas token
 * unless --live is passed, in which case it also calls canvas_get_profile and
 * reports only success/failure.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const live = process.argv.includes("--live");
const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
if (!live) {
  delete env.CANVAS_API_TOKEN;
  env.CANVAS_BASE_URL = "https://canvas.invalid.example"; // guarantees no real Canvas traffic / no keychain hit
}

const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: "pipe" });
const client = new Client({ name: "canvas-mcp-smoke", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
process.stdout.write(`tools discovered: ${tools.length}\n`);
for (const t of tools) process.stdout.write(`  - ${t.name}${t.annotations?.readOnlyHint ? " (readOnly)" : ""}\n`);
const info = await client.callTool({ name: "canvas_server_info", arguments: {} });
const text = (info.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
const parsed = JSON.parse(text);
process.stdout.write(`canvas_server_info: read_only=${parsed.read_only} endpoints=${parsed.endpoints.length}\n`);
if (live) {
  const r = await client.callTool({ name: "canvas_get_profile", arguments: {} });
  process.stdout.write(`canvas_get_profile: ${r.isError ? "FAILED " + ((r.content as Array<{ text: string }>)[0]?.text ?? "") : "ok"}\n`);
} else {
  const r = await client.callTool({ name: "canvas_list_courses", arguments: {} });
  process.stdout.write(`canvas_list_courses without token -> isError=${r.isError === true} (expected true)\n`);
}
await client.close();
