import { RuntimeConfigError, getNotificationConfigIssues } from "./config.ts";
import type { Env } from "./types.ts";

interface NotifyParams {
  title: string;
  message: string;
  env: Env;
  isRecovery?: boolean;
}

export async function sendNotifications(params: NotifyParams): Promise<void> {
  const configIssues = getNotificationConfigIssues(params.env);
  if (configIssues.length > 0) {
    throw new RuntimeConfigError(configIssues.join("; "));
  }

  const channels: Array<{ name: string; fn: () => Promise<boolean> }> = [
    { name: "slack", fn: () => sendSlack(params) },
    { name: "discord", fn: () => sendDiscord(params) },
    { name: "telegram", fn: () => sendTelegram(params) },
    { name: "email", fn: () => sendCloudflareEmail(params) },
  ];

  const results = await Promise.allSettled(channels.map((ch) => ch.fn()));

  let configured = 0;
  let succeeded = 0;
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === "rejected") {
      // Channel was configured but threw — count it as configured but failed
      configured++;
      console.error(`Notification channel ${channels[i]!.name} failed:`, result.reason);
    } else if (result.value) {
      // Channel was configured and succeeded
      configured++;
      succeeded++;
    }
    // result.value === false means channel was skipped (not configured)
  }

  if (configured === 0) {
    console.error("No notification channels configured! Alerts will not be delivered.");
    throw new Error("No notification channels configured");
  }
  if (succeeded === 0) {
    console.error(`All ${configured} configured notification channel(s) failed`);
    throw new Error(`All ${configured} configured notification channel(s) failed`);
  }
}

/** Returns true if the channel was configured and sent, false if skipped. Throws on failure. */
async function sendSlack({ title, message, env, isRecovery }: NotifyParams): Promise<boolean> {
  if (!env.SLACK_WEBHOOK_URL) return false;

  const emoji = isRecovery ? ":white_check_mark:" : ":rotating_light:";
  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `${emoji} *${title}*\n${message}`,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status}`);
  }
  return true;
}

/** Returns true if the channel was configured and sent, false if skipped. Throws on failure. */
async function sendDiscord({ title, message, env, isRecovery }: NotifyParams): Promise<boolean> {
  if (!env.DISCORD_WEBHOOK_URL) return false;

  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [
        {
          title,
          description: message,
          color: isRecovery ? 0x00ff00 : 0xff0000,
          timestamp: new Date().toISOString(),
        },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Discord webhook failed: ${res.status}`);
  }
  return true;
}

/** Returns true if the channel was configured and sent, false if skipped. Throws on failure. */
async function sendTelegram({ title, message, env }: NotifyParams): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;

  const text = `*${escapeMarkdown(title)}*\n\n${escapeMarkdown(message)}`;
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "MarkdownV2",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Telegram API failed: ${res.status}`);
  }
  return true;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

/** Returns true if the channel was configured and sent, false if skipped. Throws on failure. */
async function sendCloudflareEmail({ title, message, env }: NotifyParams): Promise<boolean> {
  if (!env.EMAIL || !env.EMAIL_FROM || !env.EMAIL_TO) return false;

  await env.EMAIL.send({
    from: { name: "Deadman Switch", email: env.EMAIL_FROM },
    to: env.EMAIL_TO,
    subject: title,
    text: message,
  });
  return true;
}
