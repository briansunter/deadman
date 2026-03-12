import { z } from "zod/v4";

// --- Env ---

export interface Env extends Cloudflare.Env {
  // Auth
  AUTH_TOKEN: string;
  // Slack
  SLACK_WEBHOOK_URL?: string;
  // Discord
  DISCORD_WEBHOOK_URL?: string;
  // Telegram
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  // Cloudflare Email Routing
  EMAIL_FROM?: string;
  EMAIL_TO?: string;
}

// --- Alertmanager webhook payload (Zod validated) ---
// Only validate the fields we actually use. Lenient on everything else so
// Alertmanager version changes don't silently break the dead man's switch.

const AlertmanagerAlertSchema = z
  .object({
    status: z.enum(["firing", "resolved"]),
    labels: z.record(z.string(), z.string()),
  })
  .loose();

export const AlertmanagerPayloadSchema = z
  .object({
    alerts: z.array(AlertmanagerAlertSchema).min(1),
  })
  .loose();

export type AlertmanagerPayload = z.infer<typeof AlertmanagerPayloadSchema>;
export type AlertmanagerAlert = z.infer<typeof AlertmanagerAlertSchema>;

// --- Heartbeat state ---

export interface HeartbeatState {
  lastHeartbeat: number;
  lastAlertSent: number;
  isAlerting: boolean;
  source: string;
}
