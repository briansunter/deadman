import { describe, expect, test } from "bun:test";
import {
  RuntimeConfigError,
  assertRuntimeConfig,
  getNotificationConfigIssues,
  getRuntimeConfigIssues,
} from "./config.ts";

const baseEnv = {
  AUTH_TOKEN: "super-secret-token",
  HEARTBEAT_TIMEOUT_SECONDS: "300",
  ALERT_COOLDOWN_SECONDS: "900",
  DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
};

describe("runtime config validation", () => {
  test("accepts a complete Discord-only configuration", () => {
    expect(() => assertRuntimeConfig(baseEnv as never)).not.toThrow();
  });

  test("rejects partial Telegram configuration", () => {
    expect(
      getNotificationConfigIssues({
        ...baseEnv,
        DISCORD_WEBHOOK_URL: undefined,
        TELEGRAM_BOT_TOKEN: "token-only",
      } as never)
    ).toContain("Telegram notifications require both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  });

  test("rejects missing notification channels", () => {
    expect(
      getRuntimeConfigIssues({
        AUTH_TOKEN: "super-secret-token",
        HEARTBEAT_TIMEOUT_SECONDS: "300",
        ALERT_COOLDOWN_SECONDS: "900",
      } as never)
    ).toContain(
      "At least one notification channel must be fully configured (Discord, Telegram, or Email)"
    );
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
});
