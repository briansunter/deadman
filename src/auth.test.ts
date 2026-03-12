import { describe, expect, test } from "bun:test";
import { verifyAuth } from "./auth.ts";

describe("verifyAuth", () => {
  test("accepts a valid bearer token", async () => {
    const request = new Request("https://deadman.example/status", {
      headers: { Authorization: "Bearer super-secret-token" },
    });

    const authorized = await verifyAuth(request, {
      AUTH_TOKEN: "super-secret-token",
    } as never);

    expect(authorized).toBe(true);
  });

  test("rejects query string tokens", async () => {
    const request = new Request("https://deadman.example/status?token=super-secret-token");

    const authorized = await verifyAuth(request, {
      AUTH_TOKEN: "super-secret-token",
    } as never);

    expect(authorized).toBe(false);
  });

  test("rejects missing auth configuration", async () => {
    const request = new Request("https://deadman.example/status", {
      headers: { Authorization: "Bearer anything" },
    });

    const authorized = await verifyAuth(request, {
      AUTH_TOKEN: "",
    } as never);

    expect(authorized).toBe(false);
  });
});
