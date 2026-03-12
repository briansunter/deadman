import { describe, expect, mock, test } from "bun:test";

const getStatus = mock(
  async () =>
    new Response(JSON.stringify({ status: "healthy" }), {
      headers: { "Content-Type": "application/json" },
    })
);
const recordHeartbeat = mock(
  async (source: string) =>
    new Response(JSON.stringify({ status: "ok", source }), {
      headers: { "Content-Type": "application/json" },
    })
);

mock.module("cloudflare:email", () => ({
  EmailMessage: class EmailMessage {},
}));

mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject<T> {
    constructor(
      public ctx: unknown,
      public env: T
    ) {}
  },
}));

const { default: worker } = await import("./index.ts");

function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    AUTH_TOKEN: "super-secret-token",
    HEARTBEAT_TIMEOUT_SECONDS: "300",
    ALERT_COOLDOWN_SECONDS: "900",
    DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
    HEARTBEAT_MONITOR: {
      idFromName: () => "singleton-id",
      get: () => ({
        getStatus,
        recordHeartbeat,
        checkHeartbeat: async () => {},
      }),
    },
    ...overrides,
  } as never;
}

describe("worker fetch handler", () => {
  test("returns 405 for /status with the wrong method", async () => {
    const response = await worker.fetch(
      new Request("https://deadman.example/status", { method: "POST" }),
      createEnv()
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });

  test("returns 405 for /webhook/alertmanager with the wrong method", async () => {
    const response = await worker.fetch(
      new Request("https://deadman.example/webhook/alertmanager", { method: "GET" }),
      createEnv()
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });

  test("rejects query-string authentication", async () => {
    const response = await worker.fetch(
      new Request("https://deadman.example/status?token=super-secret-token"),
      createEnv()
    );

    expect(response.status).toBe(401);
  });

  test("returns 500 for incomplete notification config", async () => {
    const response = await worker.fetch(
      new Request("https://deadman.example/status", {
        headers: { Authorization: "Bearer super-secret-token" },
      }),
      createEnv({
        DISCORD_WEBHOOK_URL: undefined,
        TELEGRAM_BOT_TOKEN: "token-only",
      })
    );

    expect(response.status).toBe(500);
  });

  test("serves /status with header authentication", async () => {
    const response = await worker.fetch(
      new Request("https://deadman.example/status", {
        headers: { Authorization: "Bearer super-secret-token" },
      }),
      createEnv()
    );

    expect(response.status).toBe(200);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });
});
