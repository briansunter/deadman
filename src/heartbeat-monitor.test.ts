import { beforeEach, describe, expect, mock, test } from "bun:test";

const sendNotifications = mock(async () => {});

mock.module("./notify.ts", () => ({
  sendNotifications,
}));

mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject<T> {
    constructor(
      public ctx: unknown,
      public env: T
    ) {}
  },
}));

const { HeartbeatMonitor } = await import("./heartbeat-monitor.ts");

interface TestState {
  lastHeartbeat: number;
  lastAlertSent: number;
  isAlerting: boolean;
  source: string;
}

function createStorage(initialState?: TestState) {
  let alarm: number | null = null;
  let state = initialState;

  return {
    async get<T>(key: string): Promise<T | undefined> {
      if (key !== "state") return undefined;
      return state as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      if (key === "state") {
        state = value as TestState;
      }
    },
    async setAlarm(value: number): Promise<void> {
      alarm = value;
    },
    async getAlarm(): Promise<number | null> {
      return alarm;
    },
    snapshot() {
      return { alarm, state };
    },
  };
}

function createMonitor(initialState?: TestState) {
  const storage = createStorage(initialState);
  const monitor = new HeartbeatMonitor(
    { storage } as never,
    {
      HEARTBEAT_TIMEOUT_SECONDS: "300",
      ALERT_COOLDOWN_SECONDS: "900",
      DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
    } as never
  );

  return { monitor, storage };
}

describe("HeartbeatMonitor", () => {
  beforeEach(() => {
    sendNotifications.mockClear();
  });

  test("sends a recovery notification when a heartbeat resumes", async () => {
    const { monitor, storage } = createMonitor({
      lastHeartbeat: Date.now() - 600_000,
      lastAlertSent: Date.now() - 60_000,
      isAlerting: true,
      source: "alertmanager:Watchdog",
    });

    const response = await monitor.recordHeartbeat("alertmanager:Watchdog");
    const body = (await response.json()) as { status: string };
    const snapshot = storage.snapshot();
    const firstCall = sendNotifications.mock.calls[0];

    expect(body.status).toBe("ok");
    expect(snapshot.state?.isAlerting).toBe(false);
    expect(snapshot.state?.source).toBe("alertmanager:Watchdog");
    expect(snapshot.alarm).not.toBeNull();
    expect(sendNotifications).toHaveBeenCalledTimes(1);
    expect(firstCall).toBeDefined();
    expect((firstCall as unknown as [Record<string, unknown>])[0]).toMatchObject({
      title: "Deadman Switch - RECOVERED",
      isRecovery: true,
    });
  });

  test("sends an alert when the heartbeat expires", async () => {
    const { monitor, storage } = createMonitor({
      lastHeartbeat: Date.now() - 600_000,
      lastAlertSent: 0,
      isAlerting: false,
      source: "alertmanager:Watchdog",
    });

    await monitor.alarm();
    const snapshot = storage.snapshot();

    expect(sendNotifications).toHaveBeenCalledTimes(1);
    expect(snapshot.state?.isAlerting).toBe(true);
    expect(snapshot.state?.lastAlertSent).toBeGreaterThan(0);
  });

  test("respects the alert cooldown", async () => {
    const { monitor, storage } = createMonitor({
      lastHeartbeat: Date.now() - 600_000,
      lastAlertSent: Date.now() - 30_000,
      isAlerting: true,
      source: "alertmanager:Watchdog",
    });

    await monitor.alarm();
    const snapshot = storage.snapshot();

    expect(sendNotifications).not.toHaveBeenCalled();
    expect(snapshot.state?.lastAlertSent).toBeGreaterThan(Date.now() - 31_000);
  });
});
