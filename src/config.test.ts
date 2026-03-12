import { describe, expect, test } from "bun:test";
import {
  RuntimeConfigError,
  assertRuntimeConfig,
  getAlertCooldownMs,
  getHeartbeatTimeoutMs,
  getNotificationConfigIssues,
  getRuntimeConfigIssues,
  renderAlertTitle,
  renderAlertMessage,
  renderRecoveryTitle,
  renderRecoveryMessage,
  type AlertTemplateVars,
} from "./config.ts";

const baseEnv = {
  AUTH_TOKEN: "super-secret-token",
  HEARTBEAT_TIMEOUT_SECONDS: "300",
  ALERT_COOLDOWN_SECONDS: "900",
  DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
};

const baseVars: AlertTemplateVars = {
  elapsed_minutes: "10",
  source: "alertmanager:Watchdog",
  last_heartbeat: "2026-03-12T00:00:00.000Z",
  checked_at: "2026-03-12T00:10:00.000Z",
};

// --- Runtime config validation ---

describe("runtime config validation", () => {
  test("accepts a complete Discord-only configuration", () => {
    expect(() => assertRuntimeConfig(baseEnv as never)).not.toThrow();
  });

  test("accepts a complete Slack-only configuration", () => {
    expect(() =>
      assertRuntimeConfig({
        AUTH_TOKEN: "token",
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/xxx",
      } as never)
    ).not.toThrow();
  });

  test("accepts a complete Telegram configuration", () => {
    expect(() =>
      assertRuntimeConfig({
        AUTH_TOKEN: "token",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_CHAT_ID: "12345",
      } as never)
    ).not.toThrow();
  });

  test("accepts a complete Email configuration", () => {
    expect(() =>
      assertRuntimeConfig({
        AUTH_TOKEN: "token",
        EMAIL_FROM: "from@example.com",
        EMAIL_TO: "to@example.com",
        EMAIL: { send: async () => {} },
      } as never)
    ).not.toThrow();
  });

  test("accepts multiple channels configured", () => {
    expect(() =>
      assertRuntimeConfig({
        AUTH_TOKEN: "token",
        DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/xxx",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_CHAT_ID: "12345",
      } as never)
    ).not.toThrow();
  });

  test("rejects missing AUTH_TOKEN", () => {
    const issues = getRuntimeConfigIssues({
      DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
    } as never);
    expect(issues).toContain("AUTH_TOKEN is required");
  });

  test("rejects empty AUTH_TOKEN", () => {
    const issues = getRuntimeConfigIssues({
      AUTH_TOKEN: "",
      DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
    } as never);
    expect(issues).toContain("AUTH_TOKEN is required");
  });

  test("rejects whitespace-only AUTH_TOKEN", () => {
    const issues = getRuntimeConfigIssues({
      AUTH_TOKEN: "   ",
      DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
    } as never);
    expect(issues).toContain("AUTH_TOKEN is required");
  });

  test("rejects partial Telegram configuration - token only", () => {
    expect(
      getNotificationConfigIssues({
        TELEGRAM_BOT_TOKEN: "token-only",
      } as never)
    ).toContain("Telegram notifications require both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  });

  test("rejects partial Telegram configuration - chat ID only", () => {
    expect(
      getNotificationConfigIssues({
        TELEGRAM_CHAT_ID: "12345",
      } as never)
    ).toContain("Telegram notifications require both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  });

  test("rejects partial Email configuration - FROM only", () => {
    expect(
      getNotificationConfigIssues({
        EMAIL_FROM: "from@example.com",
      } as never)
    ).toContain("Email notifications require both EMAIL_FROM and EMAIL_TO");
  });

  test("rejects partial Email configuration - TO only", () => {
    expect(
      getNotificationConfigIssues({
        EMAIL_TO: "to@example.com",
      } as never)
    ).toContain("Email notifications require both EMAIL_FROM and EMAIL_TO");
  });

  test("rejects Email without EMAIL binding", () => {
    expect(
      getNotificationConfigIssues({
        EMAIL_FROM: "from@example.com",
        EMAIL_TO: "to@example.com",
      } as never)
    ).toContain("Email notifications require the EMAIL binding");
  });

  test("rejects missing notification channels", () => {
    expect(
      getRuntimeConfigIssues({
        AUTH_TOKEN: "super-secret-token",
        HEARTBEAT_TIMEOUT_SECONDS: "300",
        ALERT_COOLDOWN_SECONDS: "900",
      } as never)
    ).toContain(
      "At least one notification channel must be fully configured (Slack, Discord, Telegram, or Email)"
    );
  });

  test("throws RuntimeConfigError with all issues joined", () => {
    expect(() =>
      assertRuntimeConfig({} as never)
    ).toThrow(RuntimeConfigError);
  });

  test("throws for invalid timeout values", () => {
    expect(
      () =>
        assertRuntimeConfig({
          ...baseEnv,
          HEARTBEAT_TIMEOUT_SECONDS: "0",
        } as never)
    ).toThrow(RuntimeConfigError);
  });

  test("throws for negative timeout", () => {
    expect(
      () =>
        assertRuntimeConfig({
          ...baseEnv,
          HEARTBEAT_TIMEOUT_SECONDS: "-1",
        } as never)
    ).toThrow(RuntimeConfigError);
  });

  test("throws for non-numeric timeout", () => {
    expect(
      () =>
        assertRuntimeConfig({
          ...baseEnv,
          HEARTBEAT_TIMEOUT_SECONDS: "abc",
        } as never)
    ).toThrow(RuntimeConfigError);
  });

  test("truncates float timeout to integer (parseInt behavior)", () => {
    expect(
      () =>
        assertRuntimeConfig({
          ...baseEnv,
          HEARTBEAT_TIMEOUT_SECONDS: "1.5",
        } as never)
    ).not.toThrow();
  });

  test("throws for invalid cooldown values", () => {
    expect(
      () =>
        assertRuntimeConfig({
          ...baseEnv,
          ALERT_COOLDOWN_SECONDS: "0",
        } as never)
    ).toThrow(RuntimeConfigError);
  });
});

// --- Timeout and cooldown parsing ---

describe("getHeartbeatTimeoutMs", () => {
  const env = (v: string | undefined) => ({ HEARTBEAT_TIMEOUT_SECONDS: v }) as never;

  test("returns configured value in milliseconds", () => {
    expect(getHeartbeatTimeoutMs(env("120"))).toBe(120_000);
  });

  test("returns default (300s) when not configured", () => {
    expect(getHeartbeatTimeoutMs(env(undefined))).toBe(300_000);
  });

  test("returns default for empty string", () => {
    expect(getHeartbeatTimeoutMs(env(""))).toBe(300_000);
  });

  test("returns default for whitespace-only string", () => {
    expect(getHeartbeatTimeoutMs(env("   "))).toBe(300_000);
  });

  test("throws for zero", () => {
    expect(() => getHeartbeatTimeoutMs(env("0"))).toThrow();
  });

  test("throws for negative", () => {
    expect(() => getHeartbeatTimeoutMs(env("-5"))).toThrow();
  });
});

describe("getAlertCooldownMs", () => {
  const env = (v: string | undefined) => ({ ALERT_COOLDOWN_SECONDS: v }) as never;

  test("returns configured value in milliseconds", () => {
    expect(getAlertCooldownMs(env("60"))).toBe(60_000);
  });

  test("returns default (900s) when not configured", () => {
    expect(getAlertCooldownMs(env(undefined))).toBe(900_000);
  });

  test("throws for zero", () => {
    expect(() => getAlertCooldownMs(env("0"))).toThrow();
  });
});

// --- Template rendering ---

describe("renderAlertTitle", () => {
  test("returns default title when not configured", () => {
    expect(renderAlertTitle({}, baseVars)).toBe("Deadman Switch - ALERTING SYSTEM DOWN");
  });

  test("returns default for empty string", () => {
    expect(renderAlertTitle({ ALERT_TITLE: "" }, baseVars)).toBe(
      "Deadman Switch - ALERTING SYSTEM DOWN"
    );
  });

  test("returns default for whitespace-only", () => {
    expect(renderAlertTitle({ ALERT_TITLE: "   " }, baseVars)).toBe(
      "Deadman Switch - ALERTING SYSTEM DOWN"
    );
  });

  test("renders custom title with placeholders", () => {
    expect(
      renderAlertTitle({ ALERT_TITLE: "ALERT: down for {elapsed_minutes}min" }, baseVars)
    ).toBe("ALERT: down for 10min");
  });

  test("leaves unknown placeholders intact", () => {
    expect(renderAlertTitle({ ALERT_TITLE: "{unknown} alert" }, baseVars)).toBe("{unknown} alert");
  });
});

describe("renderAlertMessage", () => {
  test("returns default message when not configured", () => {
    const msg = renderAlertMessage({}, baseVars);
    expect(msg).toContain("No heartbeat received for 10 minute(s)");
    expect(msg).toContain("alertmanager:Watchdog");
    expect(msg).toContain("2026-03-12T00:00:00.000Z");
    expect(msg).toContain("2026-03-12T00:10:00.000Z");
  });

  test("renders custom message with all placeholders", () => {
    const msg = renderAlertMessage(
      { ALERT_MESSAGE: "{elapsed_minutes} {source} {last_heartbeat} {checked_at}" },
      baseVars
    );
    expect(msg).toBe(
      "10 alertmanager:Watchdog 2026-03-12T00:00:00.000Z 2026-03-12T00:10:00.000Z"
    );
  });
});

describe("renderRecoveryTitle", () => {
  test("returns default recovery title when not configured", () => {
    expect(renderRecoveryTitle({}, baseVars)).toBe("Deadman Switch - RECOVERED");
  });

  test("renders custom recovery title", () => {
    expect(
      renderRecoveryTitle({ RECOVERY_TITLE: "RECOVERED: {source}" }, baseVars)
    ).toBe("RECOVERED: alertmanager:Watchdog");
  });
});

describe("renderRecoveryMessage", () => {
  test("returns default recovery message when not configured", () => {
    const msg = renderRecoveryMessage({}, baseVars);
    expect(msg).toContain("Alerting system is back online");
    expect(msg).toContain("alertmanager:Watchdog");
  });

  test("renders custom recovery message", () => {
    expect(
      renderRecoveryMessage({ RECOVERY_MESSAGE: "Back at {checked_at}" }, baseVars)
    ).toBe("Back at 2026-03-12T00:10:00.000Z");
  });
});
