import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mockCloudflareWorkers } from "./test-helpers.ts";

mockCloudflareWorkers();

const mockFetch = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
  return new Response("ok", { status: 200 });
});

// @ts-expect-error — overriding global fetch for tests
globalThis.fetch = mockFetch;

const { sendNotifications } = await import("./notify.ts");

function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
    ...overrides,
  } as never;
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => new Response("ok", { status: 200 }));
});

describe("sendNotifications", () => {
  test("sends to Discord when configured", async () => {
    await sendNotifications({
      title: "Test Alert",
      message: "Something went wrong",
      env: createEnv(),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.example/webhook");
    const body = JSON.parse(init.body as string);
    expect(body.embeds[0].title).toBe("Test Alert");
    expect(body.embeds[0].color).toBe(0xff0000);
  });

  test("uses green color for recovery notifications", async () => {
    await sendNotifications({
      title: "Recovered",
      message: "Back online",
      env: createEnv(),
      isRecovery: true,
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.embeds[0].color).toBe(0x00ff00);
  });

  test("sends to Slack when configured", async () => {
    await sendNotifications({
      title: "Test",
      message: "msg",
      env: createEnv({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/test", DISCORD_WEBHOOK_URL: undefined }),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.com/test");
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain(":rotating_light:");
    expect(body.text).toContain("*Test*");
  });

  test("Slack uses check mark emoji for recovery", async () => {
    await sendNotifications({
      title: "Recovered",
      message: "ok",
      env: createEnv({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/test", DISCORD_WEBHOOK_URL: undefined }),
      isRecovery: true,
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain(":white_check_mark:");
  });

  test("sends to Telegram when configured", async () => {
    await sendNotifications({
      title: "Test",
      message: "msg",
      env: createEnv({
        DISCORD_WEBHOOK_URL: undefined,
        TELEGRAM_BOT_TOKEN: "123:ABC",
        TELEGRAM_CHAT_ID: "-100999",
      }),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe("-100999");
    expect(body.parse_mode).toBe("MarkdownV2");
  });

  test("sends to email when configured", async () => {
    const mockSend = mock(async () => {});
    await sendNotifications({
      title: "Test",
      message: "msg",
      env: createEnv({
        DISCORD_WEBHOOK_URL: undefined,
        EMAIL: { send: mockSend },
        EMAIL_FROM: "from@test.com",
        EMAIL_TO: "to@test.com",
      }),
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
    const call = mockSend.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call[0]).toMatchObject({
      subject: "Test",
      text: "msg",
      to: "to@test.com",
    });
  });

  test("throws when no channels are configured", async () => {
    await expect(
      sendNotifications({
        title: "Test",
        message: "msg",
        env: createEnv({ DISCORD_WEBHOOK_URL: undefined }),
      })
    ).rejects.toThrow("No notification channels configured");
  });

  test("throws when all configured channels fail", async () => {
    mockFetch.mockImplementation(async () => new Response("error", { status: 500 }));

    await expect(
      sendNotifications({
        title: "Test",
        message: "msg",
        env: createEnv(),
      })
    ).rejects.toThrow("All 1 configured notification channel(s) failed");
  });

  test("succeeds if at least one channel works when another fails", async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return new Response("error", { status: 500 });
      return new Response("ok", { status: 200 });
    });

    await sendNotifications({
      title: "Test",
      message: "msg",
      env: createEnv({
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/fail",
        DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
      }),
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("skips unconfigured channels without counting them", async () => {
    await sendNotifications({
      title: "Test",
      message: "msg",
      env: createEnv({
        DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
        // Telegram partially configured — skipped
        TELEGRAM_BOT_TOKEN: undefined,
      }),
    });

    // Only Discord should be called
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("throws RuntimeConfigError for incomplete Telegram config", async () => {
    await expect(
      sendNotifications({
        title: "Test",
        message: "msg",
        env: createEnv({
          DISCORD_WEBHOOK_URL: undefined,
          TELEGRAM_BOT_TOKEN: "token-only",
        }),
      })
    ).rejects.toThrow("TELEGRAM");
  });

  test("fetch calls include abort signal timeout", async () => {
    await sendNotifications({
      title: "Test",
      message: "msg",
      env: createEnv(),
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeDefined();
  });
});
