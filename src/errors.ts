/**
 * Error types. Messages are written for the end user and must never contain
 * the API token. `redact()` is applied defensively before anything leaves
 * the process (tool output or stderr).
 */

export type CanvasErrorKind =
  | "config"
  | "auth"
  | "permission"
  | "not_found"
  | "rate_limited"
  | "timeout"
  | "network"
  | "http"
  | "security"
  | "validation"
  | "too_large"
  | "unsupported";

export class CanvasError extends Error {
  readonly kind: CanvasErrorKind;
  readonly status?: number;
  constructor(kind: CanvasErrorKind, message: string, status?: number) {
    super(message);
    this.name = "CanvasError";
    this.kind = kind;
    this.status = status;
  }
}

export const missingTokenMessage = (origin: string) =>
  `No Canvas API token is configured for ${origin}. ` +
  `Store one in the macOS Keychain with \`npm run token:setup\` (recommended), ` +
  `or set the CANVAS_API_TOKEN environment variable for the server process.`;

export const invalidTokenMessage =
  "Canvas rejected the API token (invalid, expired, or revoked). " +
  "UW–Madison tokens expire within 30 days: request a new one via the Canvas Access Token Request form " +
  "(https://kb.wisc.edu/instructional-resources/156712), activate it in Canvas, then store it with `npm run token:setup` " +
  "and restart your MCP client. (On other Canvas instances: Account → Settings → Approved Integrations.)";

const secrets = new Set<string>();

/** Register a secret value so it is scrubbed from any outgoing text. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  // Defensive: scrub anything that looks like a bearer header or Canvas token.
  out = out.replace(/Bearer\s+[A-Za-z0-9~._-]{16,}/g, "Bearer [REDACTED]");
  out = out.replace(/\b\d{3,6}~[A-Za-z0-9]{32,}\b/g, "[REDACTED]");
  return out;
}

/** stderr-only logger. stdout is reserved for the MCP protocol. */
export function logError(msg: string): void {
  process.stderr.write(`[canvas-mcp] ${redact(msg)}\n`);
}
