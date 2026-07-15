import { describe, it, expect } from "vitest";
import { makeGuardedFetch, DEFAULT_GUARD } from "../src/guarded-fetch.js";

/**
 * The remote MCP Worker is a PUBLIC surface, so its guarded fetch must block
 * private/internal targets with NO opt-out (allowPrivateHosts is always false).
 * These assert the guard is wired active without touching the real network — a
 * blocked entry URL throws BEFORE any fetch call.
 */
describe("remote MCP guarded fetch (public, no opt-out)", () => {
  it("blocks the cloud metadata IP", async () => {
    const gf = makeGuardedFetch(DEFAULT_GUARD);
    await expect(gf("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /ssrf_blocked/,
    );
  });

  it("blocks loopback + RFC1918 hosts", async () => {
    const gf = makeGuardedFetch(DEFAULT_GUARD);
    await expect(gf("http://127.0.0.1:8080/")).rejects.toThrow(/ssrf_blocked/);
    await expect(gf("http://10.0.0.5/")).rejects.toThrow(/ssrf_blocked/);
    await expect(gf("http://192.168.1.1/")).rejects.toThrow(/ssrf_blocked/);
  });

  it("blocks a non-http(s) scheme", async () => {
    const gf = makeGuardedFetch(DEFAULT_GUARD);
    await expect(gf("file:///etc/passwd")).rejects.toThrow(/ssrf_blocked/);
  });
});
