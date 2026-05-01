import type { Env } from "./types.ts";

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_COOLDOWN_SECONDS = 900;
const MAX_SAFE_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

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

export function getOptionalEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function hasValue(value: string | undefined): boolean {
  return getOptionalEnvValue(value) !== undefined;
}

function parsePositiveInteger(
  name: string,
  value: string | undefined,
  fallback: number
): number {
  const rawValue = getOptionalEnvValue(value) ?? String(fallback);

  if (!/^\d+$/.test(rawValue)) {
    throw new RuntimeConfigError(`${name} must be a positive integer`);
  }

  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_SAFE_SECONDS) {
    throw new RuntimeConfigError(`${name} must be a safe positive integer`);
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
    issues.push(error instanceof Error ? error.message : String(error));
  }

  try {
    getAlertCooldownMs(env as Pick<Env, "ALERT_COOLDOWN_SECONDS">);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
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
  const slackWebhookUrl = getOptionalEnvValue(env.SLACK_WEBHOOK_URL);
  const discordWebhookUrl = getOptionalEnvValue(env.DISCORD_WEBHOOK_URL);
  const telegramBotToken = getOptionalEnvValue(env.TELEGRAM_BOT_TOKEN);
  const telegramChatId = getOptionalEnvValue(env.TELEGRAM_CHAT_ID);
  const emailFrom = getOptionalEnvValue(env.EMAIL_FROM);
  const emailTo = getOptionalEnvValue(env.EMAIL_TO);

  const slackUrlIssues = slackWebhookUrl
    ? getHttpsUrlIssues("SLACK_WEBHOOK_URL", slackWebhookUrl)
    : [];
  issues.push(...slackUrlIssues);

  const discordUrlIssues = discordWebhookUrl
    ? getHttpsUrlIssues("DISCORD_WEBHOOK_URL", discordWebhookUrl)
    : [];
  issues.push(...discordUrlIssues);

  if (Boolean(telegramBotToken) !== Boolean(telegramChatId)) {
    issues.push("Telegram notifications require both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  }

  if (Boolean(emailFrom) !== Boolean(emailTo)) {
    issues.push("Email notifications require both EMAIL_FROM and EMAIL_TO");
  }

  if ((emailFrom || emailTo) && !env.EMAIL) {
    issues.push("Email notifications require the EMAIL binding");
  }

  const hasSlack = Boolean(slackWebhookUrl && slackUrlIssues.length === 0);
  const hasDiscord = Boolean(discordWebhookUrl && discordUrlIssues.length === 0);
  const hasTelegram = Boolean(telegramBotToken && telegramChatId);
  const hasEmail = Boolean(emailFrom && emailTo && env.EMAIL);

  return {
    hasCompleteChannel: hasSlack || hasDiscord || hasTelegram || hasEmail,
    issues,
  };
}

function getHttpsUrlIssues(name: string, value: string): string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [`${name} must be a valid HTTPS URL`];
  }

  return url.protocol === "https:" ? [] : [`${name} must be a valid HTTPS URL`];
}
