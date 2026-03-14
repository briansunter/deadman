# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Deadman is a Cloudflare Worker that acts as a dead man's switch for Prometheus/Alertmanager. It expects periodic Watchdog heartbeat alerts and notifies via Discord, Telegram, or Cloudflare Email Routing when they stop arriving.

## Commands

```bash
bun install              # Install dependencies
bun run dev              # Local development (wrangler dev)
bun run deploy           # Deploy to Cloudflare Workers
bun run typecheck        # Type check (tsc --noEmit)
bun run test             # Run tests (bun test)
bun run tail             # Stream logs from deployed worker
```

Use `bun` instead of `npm`/`node` for all commands.

## Architecture

**Runtime**: Cloudflare Workers + Durable Objects (SQLite storage). Not a Bun server — don't use `Bun.serve()`, `Bun.file`, etc. Use Workers/DO APIs.

**Request flow**:
1. Alertmanager POSTs Watchdog alert → `/webhook/alertmanager`
2. Worker validates auth (timing-safe Bearer token), parses payload with Zod
3. Only `Watchdog`/`DeadMansSwitch`/`InfoInhibitor` alerts refresh the heartbeat — other alerts are ignored
4. HeartbeatMonitor Durable Object records timestamp, schedules alarm at `now + timeout`
5. Alarm fires → if elapsed > timeout, triggers notifications; alarm re-schedules itself
6. Alert cooldown prevents repeated notifications (default 15 min)

**Key files**:
- `src/index.ts` — Worker fetch handler, routes. Re-exports `HeartbeatMonitor` DO class.
- `src/heartbeat-monitor.ts` — Singleton Durable Object. State machine with `lastHeartbeat`, `lastAlertSent`, `isAlerting`. Uses DO alarms with self-rescheduling.
- `src/notify.ts` — Multi-channel notification dispatcher. Channels return `false` if unconfigured, `true` on success, throw on failure.
- `src/auth.ts` — HMAC-based timing-safe token comparison.
- `src/types.ts` — `Env` interface, Zod schemas for Alertmanager payloads, `HeartbeatState`.

**Notification delivery semantics**: Alert state (`isAlerting`/`lastAlertSent`) is only persisted after at least one notification channel succeeds. If all channels fail, the next alarm cycle retries.

## Configuration

Worker config is in `wrangler.toml`. Secrets are set via `wrangler secret put <NAME>`:
- `AUTH_TOKEN` (required)
- `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `EMAIL_FROM`, `EMAIL_TO` (optional)

Env vars `HEARTBEAT_TIMEOUT_SECONDS` (default 300) and `ALERT_COOLDOWN_SECONDS` (default 900) are set in `wrangler.toml [vars]`. Both validate to positive integers at runtime.

Local dev secrets go in `.dev.vars` (see `.dev.vars.example`).
