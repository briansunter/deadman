import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mockCloudflareWorkers } from "./test-helpers.ts";

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
const resetState = mock(
  async () =>
    new Response(JSON.stringify({ status: "reset" }), {
      headers: { "Content-Type": "application/json" },
    })
);

mock.module("cloudflare:email", () => ({
  EmailMessage: class EmailMessage {},
}));

mockCloudflareWorkers();

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
        resetState,
      }),
    },
    ...overrides,
  } as never;
}

function authReq(path: string, opts: RequestInit = {}) {
  return new Request(`https://deadman.example${path}`, {
    ...opts,
    headers: {
      Authorization: "Bearer super-secret-token",
      ...((opts.headers as Record<string, string>) ?? {}),
    },
  });
}

beforeEach(() => {
  getStatus.mockClear();
  recordHeartbeat.mockClear();
  resetState.mockClear();
});

// --- /health ---

describe("/health", () => {
  test("returns 200 ok without auth", async () => {
    const res = await worker.fetch(
      new Request("https://deadman.example/health"),
      createEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("allows HEAD method", async () => {
    const res = await worker.fetch(
      new Request("https://deadman.example/health", { method: "HEAD" }),
      createEnv()
    );
    expect(res.status).toBe(200);
  });

  test("returns 405 for POST", async () => {
    const res = await worker.fetch(
      new Request("https://deadman.example/health", { method: "POST" }),
      createEnv()
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
  });

  test("works even with no AUTH_TOKEN configured", async () => {
    const res = await worker.fetch(
      new Request("https://deadman.example/health"),
      createEnv({ AUTH_TOKEN: "" })
    );
    expect(res.status).toBe(200);
  });
});

// --- /status ---

describe("/status", () => {
  test("returns 405 for POST", async () => {
    const response = await worker.fetch(
      new Request("https://deadman.example/status", { method: "POST" }),
      createEnv()
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });

  test("returns 401 without auth", async () => {
    const response = await worker.fetch(
      new Request("https://deadman.example/status"),
      createEnv()
    );
    expect(response.status).toBe(401);
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
      authReq("/status"),
      createEnv({
        DISCORD_WEBHOOK_URL: undefined,
        TELEGRAM_BOT_TOKEN: "token-only",
      })
    );
    expect(response.status).toBe(500);
  });

  test("returns 500 when AUTH_TOKEN is missing", async () => {
    const response = await worker.fetch(
      new Request("https://deadman.example/status", {
        headers: { Authorization: "Bearer something" },
      }),
      createEnv({ AUTH_TOKEN: "" })
    );
    expect(response.status).toBe(500);
  });

  test("serves /status with valid auth", async () => {
    const response = await worker.fetch(authReq("/status"), createEnv());
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string };
    expect(body.status).toBe("healthy");
  });
});

// --- /webhook/alertmanager ---

describe("/webhook/alertmanager", () => {
  test("returns 405 for GET", async () => {
    const response = await worker.fetch(
      new Request("https://deadman.example/webhook/alertmanager", { method: "GET" }),
      createEnv()
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });

  test("returns 401 without auth", async () => {
    const response = await worker.fetch(
      new Request("https://deadman.example/webhook/alertmanager", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alerts: [{ status: "firing", labels: { alertname: "Watchdog" } }] }),
      }),
      createEnv()
    );
    expect(response.status).toBe(401);
  });

  test("returns 400 for invalid JSON", async () => {
    const response = await worker.fetch(
      authReq("/webhook/alertmanager", {
        method: "POST",
        body: "not json",
      }),
      createEnv()
    );
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("Invalid JSON body");
  });

  test("returns 400 for invalid payload schema", async () => {
    const response = await worker.fetch(
      authReq("/webhook/alertmanager", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wrong: "shape" }),
      }),
      createEnv()
    );
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("Invalid payload");
  });

  test("returns 400 for empty alerts array", async () => {
    const response = await worker.fetch(
      authReq("/webhook/alertmanager", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alerts: [] }),
      }),
      createEnv()
    );
    expect(response.status).toBe(400);
  });

  for (const alertname of ["Watchdog", "DeadMansSwitch", "InfoInhibitor"]) {
    test(`records heartbeat for ${alertname} alert`, async () => {
      const response = await worker.fetch(
        authReq("/webhook/alertmanager", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            alerts: [{ status: "firing", labels: { alertname } }],
          }),
        }),
        createEnv()
      );
      expect(response.status).toBe(200);
      expect(recordHeartbeat).toHaveBeenCalledWith(`alertmanager:${alertname}`);
    });
  }

  test("ignores non-watchdog alerts", async () => {
    const response = await worker.fetch(
      authReq("/webhook/alertmanager", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alerts: [{ status: "firing", labels: { alertname: "HighMemoryUsage" } }],
        }),
      }),
      createEnv()
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; reason: string };
    expect(body.status).toBe("ignored");
    expect(recordHeartbeat).not.toHaveBeenCalled();
  });

  test("ignores resolved Watchdog alerts", async () => {
    const response = await worker.fetch(
      authReq("/webhook/alertmanager", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alerts: [{ status: "resolved", labels: { alertname: "Watchdog" } }],
        }),
      }),
      createEnv()
    );
    const body = await response.json() as { status: string };
    expect(body.status).toBe("ignored");
    expect(recordHeartbeat).not.toHaveBeenCalled();
  });

  test("finds Watchdog among multiple alerts", async () => {
    const response = await worker.fetch(
      authReq("/webhook/alertmanager", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alerts: [
            { status: "firing", labels: { alertname: "HighCPU" } },
            { status: "firing", labels: { alertname: "Watchdog" } },
          ],
        }),
      }),
      createEnv()
    );
    expect(response.status).toBe(200);
    expect(recordHeartbeat).toHaveBeenCalledWith("alertmanager:Watchdog");
  });

  test("accepts payload with extra fields (loose schema)", async () => {
    const response = await worker.fetch(
      authReq("/webhook/alertmanager", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "4",
          groupKey: "group1",
          status: "firing",
          receiver: "deadman",
          alerts: [{
            status: "firing",
            labels: { alertname: "Watchdog", severity: "none" },
            annotations: { message: "This is a Watchdog alert" },
            startsAt: "2026-03-12T00:00:00Z",
            endsAt: "0001-01-01T00:00:00Z",
            generatorURL: "http://prometheus:9090/graph",
          }],
        }),
      }),
      createEnv()
    );
    expect(response.status).toBe(200);
    expect(recordHeartbeat).toHaveBeenCalledWith("alertmanager:Watchdog");
  });
});

// --- /ping ---

describe("/ping", () => {
  test("returns 405 for POST", async () => {
    const response = await worker.fetch(
      new Request("https://deadman.example/ping", { method: "POST" }),
      createEnv()
    );
    expect(response.status).toBe(405);
  });

  test("records heartbeat with source param", async () => {
    const response = await worker.fetch(
      authReq("/ping?source=my-script"),
      createEnv()
    );
    expect(response.status).toBe(200);
    expect(recordHeartbeat).toHaveBeenCalledWith("my-script");
  });

  test("defaults source to 'ping'", async () => {
    const response = await worker.fetch(authReq("/ping"), createEnv());
    expect(response.status).toBe(200);
    expect(recordHeartbeat).toHaveBeenCalledWith("ping");
  });
});

// --- /reset ---

describe("/reset", () => {
  test("returns 405 for GET", async () => {
    const response = await worker.fetch(authReq("/reset"), createEnv());
    expect(response.status).toBe(405);
  });

  test("resets state with POST", async () => {
    const response = await worker.fetch(
      authReq("/reset", { method: "POST" }),
      createEnv()
    );
    expect(response.status).toBe(200);
    expect(resetState).toHaveBeenCalledTimes(1);
  });
});

// --- 404 ---

describe("unknown routes", () => {
  test("returns 404 for unknown path", async () => {
    const response = await worker.fetch(authReq("/unknown"), createEnv());
    expect(response.status).toBe(404);
  });
});
