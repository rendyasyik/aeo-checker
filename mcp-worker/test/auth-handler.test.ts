import { describe, it, expect, vi } from "vitest";
import {
  handleDefault,
  consentPageHtml,
  encodeAuthRequest,
  decodeAuthRequest,
  newAnonymousUserId,
} from "../src/auth-handler.js";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

/**
 * A minimal fake of the OAuthHelpers surface the default handler uses. Only the
 * methods actually exercised are implemented; the rest throw if touched so a
 * test that accidentally hits an unmocked path fails loudly.
 */
function fakeProvider(overrides: Record<string, unknown> = {}) {
  const base = {
    parseAuthRequest: vi.fn(async (_req: Request): Promise<AuthRequest> => SAMPLE_REQ),
    lookupClient: vi.fn(async (_id: string) => ({
      clientId: "client-123",
      clientName: "Claude",
    })),
    completeAuthorization: vi.fn(async (_opts: unknown) => ({
      redirectTo: "https://claude.ai/callback?code=abc&state=xyz",
    })),
    unwrapToken: vi.fn(async (_t: string) => null as unknown),
    revokeGrant: vi.fn(async (_g: string, _u: string) => undefined),
  };
  return { ...base, ...overrides } as never;
}

const SAMPLE_REQ: AuthRequest = {
  responseType: "code",
  clientId: "client-123",
  redirectUri: "https://claude.ai/callback",
  scope: ["aeo:scan"],
  state: "xyz",
  codeChallenge: "abc123",
  codeChallengeMethod: "S256",
} as AuthRequest;

function envWith(provider: unknown) {
  return { OAUTH_PROVIDER: provider } as never;
}

describe("consent HTML + auth-request codec", () => {
  it("renders the client name + scopes and a POST form", () => {
    const html = consentPageHtml({
      clientName: "Claude",
      scopes: ["aeo:scan"],
      encodedRequest: "ENCODED",
    });
    expect(html).toMatch(/Claude/);
    expect(html).toMatch(/aeo:scan/);
    expect(html).toMatch(/method="POST"/);
    expect(html).toMatch(/name="oauthReq" value="ENCODED"/);
    expect(html).toMatch(/noindex/);
  });

  it("escapes HTML in the client name (no injection)", () => {
    const html = consentPageHtml({
      clientName: "<script>alert(1)</script>",
      scopes: [],
      encodedRequest: "x",
    });
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toMatch(/&lt;script&gt;/);
  });

  it("round-trips an AuthRequest through base64url encode/decode", () => {
    const enc = encodeAuthRequest(SAMPLE_REQ);
    expect(enc).not.toMatch(/[+/=]/); // base64url, no +/=
    const back = decodeAuthRequest(enc);
    expect(back).toEqual(SAMPLE_REQ);
  });

  it("mints distinct anonymous user ids", () => {
    const a = newAnonymousUserId();
    const b = newAnonymousUserId();
    expect(a).toMatch(/^anon_/);
    expect(a).not.toBe(b);
  });
});

describe("GET /health", () => {
  it("returns liveness without auth", async () => {
    const res = await handleDefault(
      new Request("https://mcp.example/health"),
      envWith(fakeProvider()),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("aeo-checker-mcp-worker");
  });
});

describe("GET /authorize -> minimal consent", () => {
  it("parses the request and renders the consent screen", async () => {
    const provider = fakeProvider();
    const res = await handleDefault(
      new Request("https://mcp.example/authorize?client_id=client-123&response_type=code"),
      envWith(provider),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toMatch(/Authorize AEO Checker/);
    expect(html).toMatch(/Claude/); // client name from lookupClient
    expect(provider.parseAuthRequest).toHaveBeenCalledOnce();
  });

  it("returns 400 on a malformed authorization request", async () => {
    const provider = fakeProvider({
      parseAuthRequest: vi.fn(async () => {
        throw new Error("bad request");
      }),
    });
    const res = await handleDefault(
      new Request("https://mcp.example/authorize"),
      envWith(provider),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /authorize -> completes grant + 302", () => {
  it("mints a userId, completes authorization, and redirects with the code", async () => {
    const provider = fakeProvider();
    const form = new FormData();
    form.set("oauthReq", encodeAuthRequest(SAMPLE_REQ));
    const res = await handleDefault(
      new Request("https://mcp.example/authorize", { method: "POST", body: form }),
      envWith(provider),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/code=abc/);
    expect(provider.completeAuthorization).toHaveBeenCalledOnce();
    // props.userId is the attribution key and matches the granted userId.
    const arg = provider.completeAuthorization.mock.calls[0][0] as {
      userId: string;
      props: { userId: string };
      scope: string[];
    };
    expect(arg.userId).toMatch(/^anon_/);
    expect(arg.props.userId).toBe(arg.userId);
    expect(arg.scope).toEqual(["aeo:scan"]);
  });

  it("returns 400 when the payload is missing", async () => {
    const res = await handleDefault(
      new Request("https://mcp.example/authorize", {
        method: "POST",
        body: new FormData(),
      }),
      envWith(fakeProvider()),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /revoke (RFC 7009 + kill-switch)", () => {
  it("revokes the grant when the token maps to one", async () => {
    const provider = fakeProvider({
      unwrapToken: vi.fn(async () => ({
        id: "tok1",
        grantId: "grant-9",
        userId: "anon_user",
        grant: { clientId: "c", scope: ["aeo:scan"], props: {} },
        createdAt: 0,
        expiresAt: 0,
      })),
    });
    const form = new FormData();
    form.set("token", "some-access-token");
    const res = await handleDefault(
      new Request("https://mcp.example/revoke", { method: "POST", body: form }),
      envWith(provider),
    );
    expect(res.status).toBe(200);
    expect(provider.revokeGrant).toHaveBeenCalledWith("grant-9", "anon_user");
  });

  it("returns 200 for an unknown/already-revoked token (never leaks validity)", async () => {
    const provider = fakeProvider({
      unwrapToken: vi.fn(async () => null),
    });
    const res = await handleDefault(
      new Request("https://mcp.example/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "nope" }),
      }),
      envWith(provider),
    );
    expect(res.status).toBe(200);
    expect(provider.revokeGrant).not.toHaveBeenCalled();
  });

  it("rejects a non-POST revoke", async () => {
    const res = await handleDefault(
      new Request("https://mcp.example/revoke", { method: "GET" }),
      envWith(fakeProvider()),
    );
    expect(res.status).toBe(405);
  });
});

describe("unknown route", () => {
  it("404s", async () => {
    const res = await handleDefault(
      new Request("https://mcp.example/nope"),
      envWith(fakeProvider()),
    );
    expect(res.status).toBe(404);
  });
});
