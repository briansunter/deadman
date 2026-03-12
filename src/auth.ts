import type { Env } from "./types.ts";

/**
 * Constant-time string comparison to prevent timing attacks.
 * HMACs both inputs with a fixed key so the comparison is always
 * the same length and timing regardless of input lengths.
 */
const authKeyPromise = crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode("deadman-auth-compare-key"),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"]
);

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await authKeyPromise;
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
 * AUTH_TOKEN is required. Requests must present it via
 * Authorization: Bearer <token>.
 */
export async function verifyAuth(request: Request, env: Env): Promise<boolean> {
  if (!env.AUTH_TOKEN) {
    console.error("AUTH_TOKEN not configured");
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

  return false;
}
