import { describe, expect, it } from "vitest";
import { createTokenProvider, DEFAULT_ORIGIN, loadConfig, normalizeOrigin } from "../src/config.js";

describe("config", () => {
  it("defaults to canvas.wisc.edu and requires https origin-only URLs", () => {
    expect(loadConfig({}).origin).toBe(DEFAULT_ORIGIN);
    expect(() => normalizeOrigin("http://canvas.wisc.edu")).toThrow(/https/);
    expect(() => normalizeOrigin("https://canvas.wisc.edu/api/v1")).toThrow(/origin only/);
    expect(() => normalizeOrigin("https://u:p@canvas.wisc.edu")).toThrow(/credentials/);
  });

  it("uses CANVAS_API_TOKEN when set", async () => {
    const p = createTokenProvider(DEFAULT_ORIGIN, { CANVAS_API_TOKEN: "  9999~abcdefghijklmnopqrstuvwxyzABCDEFGH  " });
    expect(await p.source()).toBe("env");
    expect(await p.getToken()).toBe("9999~abcdefghijklmnopqrstuvwxyzABCDEFGH");
  });

  it("only accepts well-formed extra download host suffixes", () => {
    expect(loadConfig({ CANVAS_DOWNLOAD_HOST_SUFFIXES: "*.files.example.com, bad host, javascript:x" }).extraDownloadHostSuffixes).toEqual(["files.example.com"]);
  });
});
