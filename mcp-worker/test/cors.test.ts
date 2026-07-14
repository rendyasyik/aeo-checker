import { describe, it, expect } from "vitest";
import {
  allowedOrigins,
  isOriginAllowed,
  corsHeaders,
} from "../src/cors.js";

describe("remote MCP CORS", () => {
  it("allows the claude.ai + claude.com host origins by default", () => {
    const env = {};
    for (const o of [
      "https://claude.ai",
      "https://www.claude.ai",
      "https://claude.com",
      "https://www.claude.com",
    ]) {
      expect(isOriginAllowed(o, env)).toBe(true);
    }
  });

  it("rejects an unlisted origin and a null origin", () => {
    expect(isOriginAllowed("https://evil.example", {})).toBe(false);
    expect(isOriginAllowed(null, {})).toBe(false);
  });

  it("adds extra origins from ALLOWED_ORIGINS (de-duped, defaults kept)", () => {
    const env = {
      ALLOWED_ORIGINS: "https://staging.example, https://claude.ai",
    };
    const list = allowedOrigins(env);
    expect(list).toContain("https://staging.example");
    // default still present, and no duplicate for the repeated claude.ai
    expect(list.filter((o) => o === "https://claude.ai")).toHaveLength(1);
    expect(isOriginAllowed("https://staging.example", env)).toBe(true);
  });

  it("echoes ACAO only for an allowed origin, never for a disallowed one", () => {
    const ok = corsHeaders("https://claude.ai", {});
    expect(ok["Access-Control-Allow-Origin"]).toBe("https://claude.ai");
    const bad = corsHeaders("https://evil.example", {});
    expect(bad["Access-Control-Allow-Origin"]).toBeUndefined();
    // Vary: Origin always set so caches never leak across origins.
    expect(bad["Vary"]).toBe("Origin");
  });

  it("exposes + allows the MCP session/protocol headers and Authorization", () => {
    const h = corsHeaders("https://claude.ai", {});
    expect(h["Access-Control-Allow-Headers"]).toMatch(/Authorization/);
    expect(h["Access-Control-Allow-Headers"]).toMatch(/mcp-session-id/);
    expect(h["Access-Control-Expose-Headers"]).toMatch(/mcp-session-id/);
    expect(h["Access-Control-Allow-Methods"]).toMatch(/POST/);
  });
});
