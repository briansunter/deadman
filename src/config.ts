import type { Env } from "./types.ts";

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_COOLDOWN_SECONDS = 900;

const DEFAULT_ALERT_TITLE = "Deadman Switch - ALERTING SYSTEM DOWN";
const DEFAULT_ALERT_MESSAGE = [
  "No heartbeat received for {elapsed_minutes} minute(s).",
  "Last heartbeat source: {source}",
  "Last heartbeat: {last_heartbeat}",
  "Checked at: {checked_at}",
  "",
  "Your Prometheus/Alertmanager alerting pipeline may be down!",
].join("\n");

const DEFAULT_RECOVERY_TITLE = "Deadman Switch - RECOVERED";
const DEFAULT_RECOVERY_MESSAGE = [
  "Alerting system is back online.",
  "Source: {source}",
  "Recovered at: {checked_at}",
].join("\n");

export interface AlertTemplateVars {
  elapsed_minutes: string;
  source: string;
  last_heartbeat: string;
  checked_at: string;
}

function renderTemplate(template: string, vars: AlertTemplateVars): string {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    key in vars ? vars[key as keyof AlertTemplateVars] : match
  );
}

export function renderAlertTitle(env: Pick<Env, "ALERT_TITLE">, vars: AlertTemplateVars): string {
  return renderTemplate(env.ALERT_TITLE?.trim() || DEFAULT_ALERT_TITLE, vars);
}

export function renderAlertMessage(env: Pick<Env, "ALERT_MESSAGE">, vars: AlertTemplateVars): string {
  return renderTemplate(env.ALERT_MESSAGE?.trim() || DEFAULT_ALERT_MESSAGE, vars);
}

export function renderRecoveryTitle(env: Pick<Env, "RECOVERY_TITLE">, vars: AlertTemplateVars): string {
  return renderTemplate(env.RECOVERY_TITLE?.trim() || DEFAULT_RECOVERY_TITLE, vars);
}

export function renderRecoveryMessage(env: Pick<Env, "RECOVERY_MESSAGE">, vars: AlertTemplateVars): string {
  return renderTemplate(env.RECOVERY_MESSAGE?.trim() || DEFAULT_RECOVERY_MESSAGE, vars);
}

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

function hasValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parsePositiveInteger(
  name: string,
  value: string | undefined,
  fallback: number
): number {
  const rawValue = hasValue(value) ? value : String(fallback);
  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RuntimeConfigError(`${name} must be a positive integer`);
  }

  return parsed;
}

export function getHeartbeatTimeoutMs(env: Pick<Env, "HEARTBEAT_TIMEOUT_SECONDS">): number {
  return parsePositiveInteger(
    "HEARTBEAT_TIMEOUT_SECONDS",
    env.HEARTBEAT_TIMEOUT_SECONDS,
    DEFAULT_TIMEOUT_SECONDS
  ) * 1000;
}

export function getAlertCooldownMs(env: Pick<Env, "ALERT_COOLDOWN_SECONDS">): number {
  return parsePositiveInteger(
    "ALERT_COOLDOWN_SECONDS",
    env.ALERT_COOLDOWN_SECONDS,
    DEFAULT_COOLDOWN_SECONDS
  ) * 1000;
}

export function getRuntimeConfigIssues(env: Partial<Env>): string[] {
  const issues: string[] = [];

  if (!hasValue(env.AUTH_TOKEN)) {
    issues.push("AUTH_TOKEN is required");
  }

  try {
    getHeartbeatTimeoutMs(env as Pick<Env, "HEARTBEAT_TIMEOUT_SECONDS">);
  } catch (error) {
    issues.push((error as Error).message);
  }

  try {
    getAlertCooldownMs(env as Pick<Env, "ALERT_COOLDOWN_SECONDS">);
  } catch (error) {
    issues.push((error as Error).message);
  }

  const { issues: notificationIssues, hasCompleteChannel } = getNotificationConfigState(env);
  issues.push(...notificationIssues);

  if (!hasCompleteChannel) {
    issues.push(
      "At least one notification channel must be fully configured (Slack, Discord, Telegram, or Email)"
    );
  }

  return issues;
}

export function assertRuntimeConfig(env: Partial<Env>): void {
  const issues = getRuntimeConfigIssues(env);

  if (issues.length > 0) {
    throw new RuntimeConfigError(issues.join("; "));
  }
}

export function getNotificationConfigIssues(env: Partial<Env>): string[] {
  return getNotificationConfigState(env).issues;
}

function getNotificationConfigState(env: Partial<Env>): {
  hasCompleteChannel: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  const hasSlack = hasValue(env.SLACK_WEBHOOK_URL);
  const hasDiscord = hasValue(env.DISCORD_WEBHOOK_URL);
  const hasTelegramToken = hasValue(env.TELEGRAM_BOT_TOKEN);
  const hasTelegramChatId = hasValue(env.TELEGRAM_CHAT_ID);
  const hasEmailFrom = hasValue(env.EMAIL_FROM);
  const hasEmailTo = hasValue(env.EMAIL_TO);

  if (hasTelegramToken !== hasTelegramChatId) {
    issues.push("Telegram notifications require both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  }

  if (hasEmailFrom !== hasEmailTo) {
    issues.push("Email notifications require both EMAIL_FROM and EMAIL_TO");
  }

  if ((hasEmailFrom || hasEmailTo) && !env.EMAIL) {
    issues.push("Email notifications require the EMAIL binding");
  }

  const hasTelegram = hasTelegramToken && hasTelegramChatId;
  const hasEmail = hasEmailFrom && hasEmailTo && Boolean(env.EMAIL);

  return {
    hasCompleteChannel: hasSlack || hasDiscord || hasTelegram || hasEmail,
    issues,
  };
}
