/**
 * Turnstile server-side verification (mitigation layer 2).
 * Verifies the invisible-widget token against Cloudflare's siteverify endpoint
 * BEFORE any target fetch happens.
 */

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileResult {
  ok: boolean;
  errorCodes: string[];
}

export async function verifyTurnstile(
  token: string,
  secret: string,
  remoteIp: string | null,
): Promise<TurnstileResult> {
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (remoteIp) form.append("remoteip", remoteIp);

  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body: form });
    if (!res.ok) {
      return { ok: false, errorCodes: [`siteverify_http_${res.status}`] };
    }
    const data = (await res.json()) as {
      success?: boolean;
      "error-codes"?: string[];
    };
    return {
      ok: data.success === true,
      errorCodes: data["error-codes"] ?? [],
    };
  } catch (e) {
    return {
      ok: false,
      errorCodes: [e instanceof Error ? e.message : "siteverify_failed"],
    };
  }
}
