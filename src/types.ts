import { z } from "zod/v4";
import type { HeartbeatMonitor } from "./heartbeat-monitor.ts";

// --- Env ---

export interface Env {
  HEARTBEAT_MONITOR: DurableObjectNamespace<HeartbeatMonitor>;
  EMAIL: SendEmail;
  // Config
  HEARTBEAT_TIMEOUT_SECONDS: string;
  ALERT_COOLDOWN_SECONDS: string;
  // Auth
  AUTH_TOKEN: string;
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

const AlertmanagerAlertSchema = z.object({
  status: z.enum(["firing", "resolved"]),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()).optional().default({}),
  startsAt: z.string(),
  endsAt: z.string(),
  generatorURL: z.string().optional().default(""),
  fingerprint: z.string(),
});

export const AlertmanagerPayloadSchema = z.object({
  version: z.string(),
  groupKey: z.string(),
  truncatedAlerts: z.number().optional().default(0),
  status: z.enum(["firing", "resolved"]),
  receiver: z.string(),
  groupLabels: z.record(z.string(), z.string()).optional().default({}),
  commonLabels: z.record(z.string(), z.string()).optional().default({}),
  commonAnnotations: z.record(z.string(), z.string()).optional().default({}),
  externalURL: z.string().optional().default(""),
  alerts: z.array(AlertmanagerAlertSchema).min(1),
});

export type AlertmanagerPayload = z.infer<typeof AlertmanagerPayloadSchema>;
export type AlertmanagerAlert = z.infer<typeof AlertmanagerAlertSchema>;

// --- Heartbeat state ---

export interface HeartbeatState {
  lastHeartbeat: number;
  lastAlertSent: number;
  isAlerting: boolean;
  source: string;
}
