import { execFile } from "node:child_process";
import { CanvasError, missingTokenMessage, registerSecret } from "./errors.js";

export const DEFAULT_ORIGIN = "https://canvas.wisc.edu";
export const KEYCHAIN_SERVICE = "canvas-mcp";

/**
 * Hosts that Canvas documents/uses for file-content redirects (Instructure
 * file storage / inst-fs / user-content domains). The bearer token is NEVER
 * sent to these hosts; they are only followed for file downloads.
 */
export const DEFAULT_DOWNLOAD_HOST_SUFFIXES = [
  "inscloudgate.net",
  "instructure-uploads.com",
  "canvas-user-content.com",
  "instructuremedia.com",
];
/** S3 buckets used by Instructure for uploads, e.g. instructure-uploads.s3.amazonaws.com */
export const DEFAULT_DOWNLOAD_HOST_PATTERNS = [
  /^instructure-uploads(?:-[a-z0-9-]+)?\.s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/,
];

export interface Config {
  origin: string;
  enableModuleTools: boolean;
  extraDownloadHostSuffixes: string[];
}

export function normalizeOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CanvasError("config", `CANVAS_BASE_URL is not a valid URL.`);
  }
  if (u.protocol !== "https:") {
    throw new CanvasError("config", "CANVAS_BASE_URL must use https://.");
  }
  if (u.username || u.password) {
    throw new CanvasError("config", "CANVAS_BASE_URL must not contain credentials.");
  }
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) {
    throw new CanvasError("config", "CANVAS_BASE_URL must be an origin only, e.g. https://canvas.wisc.edu");
  }
  return u.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const origin = normalizeOrigin(env.CANVAS_BASE_URL?.trim() || DEFAULT_ORIGIN);
  const extra = (env.CANVAS_DOWNLOAD_HOST_SUFFIXES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^\*?\./, ""))
    .filter((s) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s));
  return {
    origin,
    enableModuleTools: env.CANVAS_ENABLE_MODULE_TOOLS === "1",
    extraDownloadHostSuffixes: extra,
  };
}

export type TokenSource = "env" | "keychain";

export interface TokenProvider {
  getToken(): Promise<string>;
  source(): Promise<TokenSource | null>;
}

/** Account name used for the Keychain item: the Canvas host. */
export function keychainAccount(origin: string): string {
  return new URL(origin).host;
}

function readKeychain(origin: string): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    // The token is read from stdout of `security`; it is never placed in argv.
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keychainAccount(origin), "-w"],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const v = stdout.replace(/\r?\n$/, "").trim();
        resolve(v.length ? v : null);
      },
    );
  });
}

/**
 * Resolves the token lazily (so tool discovery works without credentials).
 * Precedence: CANVAS_API_TOKEN env var, then macOS Keychain.
 * The resolved token is cached in memory only.
 */
export function createTokenProvider(origin: string, env: NodeJS.ProcessEnv = process.env): TokenProvider {
  let cached: { token: string; source: TokenSource } | null = null;
  async function resolve(): Promise<{ token: string; source: TokenSource } | null> {
    if (cached) return cached;
    const fromEnv = env.CANVAS_API_TOKEN?.trim();
    if (fromEnv) {
      cached = { token: fromEnv, source: "env" };
    } else {
      const fromKc = await readKeychain(origin);
      if (fromKc) cached = { token: fromKc, source: "keychain" };
    }
    if (cached) {
      if (/\s/.test(cached.token)) {
        cached = null;
        throw new CanvasError("config", "The configured Canvas token contains whitespace; re-enter it with `npm run token:setup`.");
      }
      registerSecret(cached.token);
    }
    return cached;
  }
  return {
    async getToken() {
      const r = await resolve();
      if (!r) throw new CanvasError("config", missingTokenMessage(origin));
      return r.token;
    },
    async source() {
      const r = await resolve();
      return r ? r.source : null;
    },
  };
}

export function staticTokenProvider(token: string | null): TokenProvider {
  if (token) registerSecret(token);
  return {
    async getToken() {
      if (!token) throw new CanvasError("config", missingTokenMessage(DEFAULT_ORIGIN));
      return token;
    },
    async source() {
      return token ? "env" : null;
    },
  };
}
