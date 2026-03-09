import type { Env } from "./types.ts";

/**
 * Constant-time string comparison to prevent timing attacks.
 * HMACs both inputs with a fixed key so the comparison is always
 * the same length and timing regardless of input lengths.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode("deadman-auth-compare-key");
  const key = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(a)),
    crypto.subtle.sign("HMAC", key, encoder.encode(b)),
  ]);
  const viewA = new Uint8Array(sigA);
  const viewB = new Uint8Array(sigB);
  let result = 0;
  for (let i = 0; i < viewA.length; i++) {
    result |= viewA[i]! ^ viewB[i]!;
  }
  return result === 0;
}

/**
 * Verify request authentication.
 * Supports:
 *   - Bearer token in Authorization header
 *   - ?token= query parameter (for simple webhook configs)
 *
 * AUTH_TOKEN is required — the service rejects all requests if it's not set.
 */
export async function verifyAuth(request: Request, env: Env): Promise<boolean> {
  if (!env.AUTH_TOKEN) {
    console.error("AUTH_TOKEN not configured - rejecting all requests");
    return false;
  }

  // Check Authorization: Bearer <token>
  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return timingSafeEqual(match[1], env.AUTH_TOKEN);
    }
  }

  // Check ?token= query parameter
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  if (queryToken) {
    return timingSafeEqual(queryToken, env.AUTH_TOKEN);
  }

  return false;
}
