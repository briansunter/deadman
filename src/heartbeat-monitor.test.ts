import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { HeartbeatState } from "./types.ts";
import { mockCloudflareWorkers } from "./test-helpers.ts";

const sendNotifications = mock(async () => {});

mock.module("./notify.ts", () => ({
  sendNotifications,
}));

mockCloudflareWorkers();

const { HeartbeatMonitor } = await import("./heartbeat-monitor.ts");

function createStorage(initialState?: HeartbeatState) {
  let alarm: number | null = null;
  let state = initialState;
  let deleted = false;

  return {
    async get<T>(key: string): Promise<T | undefined> {
      if (key !== "state") return undefined;
      return state as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      if (key === "state") {
        state = value as HeartbeatState;
        deleted = false;
      }
    },
    async delete(key: string): Promise<void> {
      if (key === "state") {
        state = undefined;
        deleted = true;
      }
    },
    async setAlarm(value: number): Promise<void> {
      alarm = value;
    },
    async getAlarm(): Promise<number | null> {
      return alarm;
    },
    async deleteAlarm(): Promise<void> {
      alarm = null;
    },
    snapshot() {
      return { alarm, state, deleted };
    },
  };
}

function createMonitor(initialState?: HeartbeatState, envOverrides: Record<string, string> = {}) {
  const storage = createStorage(initialState);
  const monitor = new HeartbeatMonitor(
    { storage } as never,
    {
      HEARTBEAT_TIMEOUT_SECONDS: "300",
      ALERT_COOLDOWN_SECONDS: "900",
      DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
      ...envOverrides,
    } as never
  );

  return { monitor, storage };
}

describe("HeartbeatMonitor", () => {
  beforeEach(() => {
    sendNotifications.mockReset();
  });

  // --- recordHeartbeat ---

  describe("recordHeartbeat", () => {
    test("records first heartbeat and schedules alarm", async () => {
      const { monitor, storage } = createMonitor();
      const before = Date.now();

      const response = await monitor.recordHeartbeat("alertmanager:Watchdog");
      const body = (await response.json()) as { status: string; lastHeartbeat: number };
      const snapshot = storage.snapshot();

      expect(body.status).toBe("ok");
      expect(body.lastHeartbeat).toBeGreaterThanOrEqual(before);
      expect(snapshot.state?.lastHeartbeat).toBeGreaterThanOrEqual(before);
      expect(snapshot.state?.source).toBe("alertmanager:Watchdog");
      expect(snapshot.state?.isAlerting).toBe(false);
      expect(snapshot.alarm).toBeGreaterThan(before);
      expect(sendNotifications).not.toHaveBeenCalled();
    });

    test("updates source on subsequent heartbeats", async () => {
      const { monitor, storage } = createMonitor({
        lastHeartbeat: Date.now() - 30_000,
        lastAlertSent: 0,
        isAlerting: false,
        source: "alertmanager:Watchdog",
      });

      await monitor.recordHeartbeat("alertmanager:DeadMansSwitch");
      const snapshot = storage.snapshot();

      expect(snapshot.state?.source).toBe("alertmanager:DeadMansSwitch");
    });

    test("resets alarm on each heartbeat", async () => {
      const { monitor, storage } = createMonitor({
        lastHeartbeat: Date.now() - 30_000,
        lastAlertSent: 0,
        isAlerting: false,
        source: "alertmanager:Watchdog",
      });

      const before = Date.now();
      await monitor.recordHeartbeat("alertmanager:Watchdog");
      const snapshot = storage.snapshot();

      // Alarm should be ~5 min from now, not from the old heartbeat
      expect(snapshot.alarm!).toBeGreaterThanOrEqual(before + 300_000 - 100);
    });

    test("sends recovery notification when resuming after alert", async () => {
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
      expect(sendNotifications).toHaveBeenCalledTimes(1);
      expect(firstCall).toBeDefined();
      expect((firstCall as unknown as [Record<string, unknown>])[0]).toMatchObject({
        title: "Deadman Switch - RECOVERED",
        isRecovery: true,
      });
    });

    test("does not send recovery when not alerting", async () => {
      const { monitor } = createMonitor({
        lastHeartbeat: Date.now() - 30_000,
        lastAlertSent: 0,
        isAlerting: false,
        source: "alertmanager:Watchdog",
      });

      await monitor.recordHeartbeat("alertmanager:Watchdog");
      expect(sendNotifications).not.toHaveBeenCalled();
    });

    test("still records heartbeat if recovery notification fails", async () => {
      sendNotifications.mockImplementation(async () => {
        throw new Error("notification failed");
      });

      const { monitor, storage } = createMonitor({
        lastHeartbeat: Date.now() - 600_000,
        lastAlertSent: Date.now() - 60_000,
        isAlerting: true,
        source: "alertmanager:Watchdog",
      });

      const response = await monitor.recordHeartbeat("alertmanager:Watchdog");
      const body = (await response.json()) as { status: string };
      const snapshot = storage.snapshot();

      // Heartbeat should still be recorded even if recovery notification fails
      expect(body.status).toBe("ok");
      expect(snapshot.state?.isAlerting).toBe(false);
      expect(snapshot.state?.lastHeartbeat).toBeGreaterThan(0);
    });
  });

  // --- alarm ---

  describe("alarm", () => {
    test("sends alert when heartbeat has expired", async () => {
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

    test("includes elapsed minutes in alert", async () => {
      const { monitor } = createMonitor({
        lastHeartbeat: Date.now() - 600_000, // 10 minutes
        lastAlertSent: 0,
        isAlerting: false,
        source: "alertmanager:Watchdog",
      });

      await monitor.alarm();
      const call = sendNotifications.mock.calls[0] as unknown as [Record<string, unknown>];
      const message = call[0].message as string;

      expect(message).toContain("10 minute(s)");
    });

    test("does not alert when heartbeat is recent", async () => {
      const { monitor } = createMonitor({
        lastHeartbeat: Date.now() - 10_000, // 10 seconds ago
        lastAlertSent: 0,
        isAlerting: false,
        source: "alertmanager:Watchdog",
      });

      await monitor.alarm();
      expect(sendNotifications).not.toHaveBeenCalled();
    });

    test("does not alert when no heartbeat ever received", async () => {
      const { monitor } = createMonitor({
        lastHeartbeat: 0,
        lastAlertSent: 0,
        isAlerting: false,
        source: "",
      });

      await monitor.alarm();
      expect(sendNotifications).not.toHaveBeenCalled();
    });

    test("respects alert cooldown", async () => {
      const { monitor, storage } = createMonitor({
        lastHeartbeat: Date.now() - 600_000,
        lastAlertSent: Date.now() - 30_000, // 30s ago, cooldown is 900s
        isAlerting: true,
        source: "alertmanager:Watchdog",
      });

      await monitor.alarm();
      const snapshot = storage.snapshot();

      expect(sendNotifications).not.toHaveBeenCalled();
      // lastAlertSent should not change
      expect(snapshot.state?.lastAlertSent).toBeGreaterThan(Date.now() - 31_000);
    });

    test("re-alerts after cooldown expires", async () => {
      const { monitor, storage } = createMonitor({
        lastHeartbeat: Date.now() - 1_200_000, // 20 min ago
        lastAlertSent: Date.now() - 1_000_000, // ~16 min ago, cooldown is 15 min
        isAlerting: true,
        source: "alertmanager:Watchdog",
      });

      await monitor.alarm();
      const snapshot = storage.snapshot();

      expect(sendNotifications).toHaveBeenCalledTimes(1);
      expect(snapshot.state?.lastAlertSent).toBeGreaterThan(Date.now() - 1000);
    });

    test("re-schedules alarm after firing", async () => {
      const { monitor, storage } = createMonitor({
        lastHeartbeat: Date.now() - 600_000,
        lastAlertSent: 0,
        isAlerting: false,
        source: "alertmanager:Watchdog",
      });

      await monitor.alarm();
      const snapshot = storage.snapshot();

      expect(snapshot.alarm).toBeGreaterThan(Date.now());
    });

    test("re-schedules alarm even when not alerting", async () => {
      const { monitor, storage } = createMonitor({
        lastHeartbeat: Date.now() - 10_000,
        lastAlertSent: 0,
        isAlerting: false,
        source: "alertmanager:Watchdog",
      });

      await monitor.alarm();
      const snapshot = storage.snapshot();

      expect(snapshot.alarm).toBeGreaterThan(Date.now());
    });

    test("does not persist alert state if notification fails", async () => {
      sendNotifications.mockImplementation(async () => {
        throw new Error("all channels failed");
      });

      const { monitor, storage } = createMonitor({
        lastHeartbeat: Date.now() - 600_000,
        lastAlertSent: 0,
        isAlerting: false,
        source: "alertmanager:Watchdog",
      });

      await monitor.alarm();
      const snapshot = storage.snapshot();

      // Should NOT set isAlerting so the next cycle retries
      expect(snapshot.state?.isAlerting).toBe(false);
      expect(snapshot.state?.lastAlertSent).toBe(0);
    });
  });

  // --- resetState ---

  describe("resetState", () => {
    test("clears state and alarm", async () => {
      const { monitor, storage } = createMonitor({
        lastHeartbeat: Date.now(),
        lastAlertSent: Date.now(),
        isAlerting: true,
        source: "alertmanager:Watchdog",
      });

      const response = await monitor.resetState();
      const body = (await response.json()) as { status: string };
      const snapshot = storage.snapshot();

      expect(body.status).toBe("reset");
      expect(snapshot.alarm).toBeNull();
      expect(snapshot.deleted).toBe(true);
    });
  });

  // --- getStatus ---

  describe("getStatus", () => {
    test("returns 'waiting' when no heartbeat received", async () => {
      const { monitor } = createMonitor();

      const response = await monitor.getStatus();
      const body = (await response.json()) as Record<string, unknown>;

      expect(body.status).toBe("waiting");
      expect(body.lastHeartbeat).toBeNull();
      expect(body.elapsedSeconds).toBeNull();
    });

    test("returns 'healthy' when heartbeat is recent", async () => {
      const { monitor } = createMonitor({
        lastHeartbeat: Date.now() - 30_000,
        lastAlertSent: 0,
        isAlerting: false,
        source: "alertmanager:Watchdog",
      });

      const response = await monitor.getStatus();
      const body = (await response.json()) as Record<string, unknown>;

      expect(body.status).toBe("healthy");
      expect(body.elapsedSeconds).toBeGreaterThanOrEqual(29);
      expect(body.elapsedSeconds).toBeLessThan(35);
      expect(body.timeoutSeconds).toBe(300);
      expect(body.source).toBe("alertmanager:Watchdog");
    });

    test("returns 'alerting' when timeout exceeded", async () => {
      const { monitor } = createMonitor({
        lastHeartbeat: Date.now() - 600_000,
        lastAlertSent: Date.now() - 60_000,
        isAlerting: true,
        source: "alertmanager:Watchdog",
      });

      const response = await monitor.getStatus();
      const body = (await response.json()) as Record<string, unknown>;

      expect(body.status).toBe("alerting");
      expect(body.isAlerting).toBe(true);
    });

    test("derives alerting status from elapsed time, not just isAlerting flag", async () => {
      // isAlerting is false but timeout has been exceeded
      const { monitor } = createMonitor({
        lastHeartbeat: Date.now() - 600_000,
        lastAlertSent: 0,
        isAlerting: false,
        source: "alertmanager:Watchdog",
      });

      const response = await monitor.getStatus();
      const body = (await response.json()) as Record<string, unknown>;

      // Status should reflect elapsed time, not the flag
      expect(body.status).toBe("alerting");
    });

    test("returns ISO timestamp for lastHeartbeat", async () => {
      const ts = Date.now() - 30_000;
      const { monitor } = createMonitor({
        lastHeartbeat: ts,
        lastAlertSent: 0,
        isAlerting: false,
        source: "test",
      });

      const response = await monitor.getStatus();
      const body = (await response.json()) as Record<string, unknown>;

      expect(body.lastHeartbeat).toBe(new Date(ts).toISOString());
    });
  });

  // --- Custom timeout/cooldown ---

  describe("custom timeout and cooldown", () => {
    test("uses custom timeout", async () => {
      // 60s timeout, heartbeat 90s ago — should alert
      const { monitor } = createMonitor(
        {
          lastHeartbeat: Date.now() - 90_000,
          lastAlertSent: 0,
          isAlerting: false,
          source: "test",
        },
        { HEARTBEAT_TIMEOUT_SECONDS: "60" }
      );

      await monitor.alarm();
      expect(sendNotifications).toHaveBeenCalledTimes(1);
    });

    test("custom timeout - within window does not alert", async () => {
      // 600s timeout, heartbeat 90s ago — should not alert
      const { monitor } = createMonitor(
        {
          lastHeartbeat: Date.now() - 90_000,
          lastAlertSent: 0,
          isAlerting: false,
          source: "test",
        },
        { HEARTBEAT_TIMEOUT_SECONDS: "600" }
      );

      await monitor.alarm();
      expect(sendNotifications).not.toHaveBeenCalled();
    });

    test("uses custom cooldown", async () => {
      // 60s cooldown, last alert 90s ago — should re-alert
      const { monitor } = createMonitor(
        {
          lastHeartbeat: Date.now() - 600_000,
          lastAlertSent: Date.now() - 90_000,
          isAlerting: true,
          source: "test",
        },
        { ALERT_COOLDOWN_SECONDS: "60" }
      );

      await monitor.alarm();
      expect(sendNotifications).toHaveBeenCalledTimes(1);
    });

    test("custom cooldown - within window suppresses", async () => {
      // 120s cooldown, last alert 90s ago — should not re-alert
      const { monitor } = createMonitor(
        {
          lastHeartbeat: Date.now() - 600_000,
          lastAlertSent: Date.now() - 90_000,
          isAlerting: true,
          source: "test",
        },
        { ALERT_COOLDOWN_SECONDS: "120" }
      );

      await monitor.alarm();
      expect(sendNotifications).not.toHaveBeenCalled();
    });
  });
});
