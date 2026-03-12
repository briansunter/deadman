import { describe, expect, test } from "bun:test";
import { verifyAuth } from "./auth.ts";

function req(url: string, headers?: Record<string, string>) {
  return new Request(url, { headers });
}

const env = { AUTH_TOKEN: "super-secret-token" } as never;

describe("verifyAuth", () => {
  test("accepts a valid bearer token", async () => {
    expect(
      await verifyAuth(req("https://x/status", { Authorization: "Bearer super-secret-token" }), env)
    ).toBe(true);
  });

  test("rejects wrong token", async () => {
    expect(
      await verifyAuth(req("https://x/status", { Authorization: "Bearer wrong-token" }), env)
    ).toBe(false);
  });

  test("rejects missing Authorization header", async () => {
    expect(await verifyAuth(req("https://x/status"), env)).toBe(false);
  });

  test("rejects empty Authorization header", async () => {
    expect(
      await verifyAuth(req("https://x/status", { Authorization: "" }), env)
    ).toBe(false);
  });

  test("rejects Bearer with no token value", async () => {
    expect(
      await verifyAuth(req("https://x/status", { Authorization: "Bearer " }), env)
    ).toBe(false);
  });

  test("rejects Basic auth scheme", async () => {
    expect(
      await verifyAuth(
        req("https://x/status", { Authorization: "Basic c3VwZXItc2VjcmV0LXRva2Vu" }),
        env
      )
    ).toBe(false);
  });

  test("rejects query string tokens", async () => {
    expect(
      await verifyAuth(req("https://x/status?token=super-secret-token"), env)
    ).toBe(false);
  });

  test("rejects missing auth configuration", async () => {
    expect(
      await verifyAuth(
        req("https://x/status", { Authorization: "Bearer anything" }),
        { AUTH_TOKEN: "" } as never
      )
    ).toBe(false);
  });

  test("rejects undefined AUTH_TOKEN", async () => {
    expect(
      await verifyAuth(
        req("https://x/status", { Authorization: "Bearer anything" }),
        {} as never
      )
    ).toBe(false);
  });

  test("is case-insensitive for Bearer keyword", async () => {
    expect(
      await verifyAuth(req("https://x/status", { Authorization: "bearer super-secret-token" }), env)
    ).toBe(true);
  });

  test("handles token with special characters", async () => {
    const specialEnv = { AUTH_TOKEN: "abc-123_!@#$%^&*()" } as never;
    expect(
      await verifyAuth(
        req("https://x/status", { Authorization: "Bearer abc-123_!@#$%^&*()" }),
        specialEnv
      )
    ).toBe(true);
  });

  test("rejects token that is a prefix of the real token", async () => {
    expect(
      await verifyAuth(req("https://x/status", { Authorization: "Bearer super-secret" }), env)
    ).toBe(false);
  });

  test("rejects token that extends the real token", async () => {
    expect(
      await verifyAuth(
        req("https://x/status", { Authorization: "Bearer super-secret-token-extra" }),
        env
      )
    ).toBe(false);
  });
});
