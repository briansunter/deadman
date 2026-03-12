# deadman

Deadman is a Cloudflare Worker that acts as a dead man's switch for your Prometheus and Alertmanager pipeline. It expects regular watchdog heartbeats and sends alerts through channels that do not depend on your monitoring stack.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/briansunter/deadman)

If Prometheus or Alertmanager stops working, it cannot reliably tell you that it is down. Deadman runs separately on Cloudflare Workers, tracks the last known heartbeat, and alerts you when that heartbeat expires.

## What it does

- Accepts Alertmanager webhooks at `/webhook/alertmanager`
- Refreshes heartbeats only for `Watchdog`, `DeadMansSwitch`, and `InfoInhibitor`
- Stores state in a Durable Object
- Uses both Durable Object alarms and a cron trigger for redundancy
- Sends outage and recovery notifications to Discord, Telegram, and Cloudflare Email Routing
- Exposes `/status` for external checks and `/health` for simple uptime monitoring

## How it works

1. Alertmanager posts a watchdog-style alert to `/webhook/alertmanager`.
2. Deadman validates the bearer token and payload.
3. The heartbeat timestamp is recorded in a Durable Object.
4. A Durable Object alarm is scheduled for `now + HEARTBEAT_TIMEOUT_SECONDS`.
5. A cron trigger runs every minute as a backup check.
6. If the timeout is exceeded, Deadman sends notifications.
7. When heartbeats resume, Deadman sends a recovery notification.

Only dedicated deadman alerts refresh the heartbeat. Regular production alerts are ignored so a partially broken alerting pipeline cannot mask a real outage.

## Quick Start

### Option 1: Deploy from GitHub

Use the button above, then finish the post-deploy configuration in the Cloudflare dashboard or with Wrangler:

1. Set `AUTH_TOKEN`.
2. Configure at least one complete notification channel.
3. Point Alertmanager at `/webhook/alertmanager`.

### Option 2: Deploy with Wrangler

```bash
bun install
bun run cf-typegen
bun run deploy
```

After deployment, set your secrets:

```bash
wrangler secret put AUTH_TOKEN

# Optional notification channels
wrangler secret put DISCORD_WEBHOOK_URL
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
```

## Configuration

Deadman rejects startup and scheduled checks if the configuration is incomplete. That is intentional: silent misconfiguration is worse than a hard failure for this service.

### Required secret

| Name | Required | Description |
|---|---|---|
| `AUTH_TOKEN` | Yes | Bearer token required for every endpoint except `/health` |

### Notification configuration

Configure at least one complete channel.

| Channel | Required values | Notes |
|---|---|---|
| Discord | `DISCORD_WEBHOOK_URL` | Simplest option |
| Telegram | `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` | Both must be present |
| Email | `EMAIL_FROM`, `EMAIL_TO`, and the `EMAIL` binding | Uses Cloudflare Email Routing |

If you configure only part of a channel, Deadman returns `500 Service misconfigured` until you fix it.

### Worker variables

Set these in `wrangler.toml` or in your Cloudflare environment configuration.

| Variable | Default | Description |
|---|---|---|
| `HEARTBEAT_TIMEOUT_SECONDS` | `300` | Time without a heartbeat before Deadman alerts |
| `ALERT_COOLDOWN_SECONDS` | `900` | Minimum time between repeated outage notifications |
| `EMAIL_FROM` | unset | Sender address for email notifications |
| `EMAIL_TO` | unset | Recipient address for email notifications |

## Alertmanager Setup

There is a full example in [alertmanager-config.example.yaml](./alertmanager-config.example.yaml). Minimal example:

```yaml
receivers:
  - name: deadman
    webhook_configs:
      - url: https://deadman.your-worker.workers.dev/webhook/alertmanager
        http_config:
          authorization:
            type: Bearer
            credentials: <your-auth-token>
        send_resolved: false

route:
  routes:
    - match:
        alertname: Watchdog
      receiver: deadman
      group_wait: 0s
      group_interval: 1m
      repeat_interval: 1m
```

## API

All endpoints except `/health` require `Authorization: Bearer <token>`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Returns plain-text `ok` |
| `GET` | `/status` | Returns current heartbeat state |
| `POST` | `/webhook/alertmanager` | Accepts Alertmanager webhook payloads |
| `GET` | `/ping` | Records a manual heartbeat, optional `?source=` |

Unsupported methods on known routes return `405 Method Not Allowed`.

### `/status` response

```json
{
  "status": "healthy",
  "lastHeartbeat": "2026-03-08T12:00:00.000Z",
  "elapsedSeconds": 45,
  "timeoutSeconds": 300,
  "isAlerting": false,
  "source": "alertmanager:Watchdog"
}
```

Possible `status` values:

- `waiting`: no heartbeat has ever been recorded
- `healthy`: the latest heartbeat is still inside the timeout window
- `alerting`: the timeout window has been exceeded

## Local Development

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars
bun run cf-typegen
bun run dev
```

Send a sample Alertmanager heartbeat:

```bash
curl -X POST http://localhost:8787/webhook/alertmanager \
  -H "Authorization: Bearer change-me-to-a-secure-random-token" \
  -H "Content-Type: application/json" \
  -d '{
    "version": "4",
    "groupKey": "{}:{alertname=\"Watchdog\"}",
    "status": "firing",
    "receiver": "deadman",
    "alerts": [{
      "status": "firing",
      "labels": {"alertname": "Watchdog"},
      "startsAt": "2026-03-08T00:00:00Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "fingerprint": "abc123"
    }]
  }'
```

Check status:

```bash
curl http://localhost:8787/status \
  -H "Authorization: Bearer change-me-to-a-secure-random-token"
```

Record a manual heartbeat:

```bash
curl "http://localhost:8787/ping?source=manual-test" \
  -H "Authorization: Bearer change-me-to-a-secure-random-token"
```

## Operations Notes

- `/health` is only a process-level liveness check. It does not tell you whether heartbeats are arriving.
- `/status` is the endpoint to use when you want the real heartbeat state.
- A `401` response means the bearer token is missing or wrong.
- A `500` response usually means runtime configuration is incomplete, such as missing notification variables.
- Recovery notifications are sent only after Deadman had entered the alerting state.

## Development

```bash
bun run cf-typegen   # regenerate Cloudflare runtime types after wrangler.toml changes
bun run dev          # local development with Wrangler
bun run deploy       # deploy to Cloudflare
bun run tail         # stream logs from the deployed worker
bun run typecheck    # run TypeScript checks
bun run test         # run Bun tests
```

## Architecture

- Runtime: Cloudflare Workers
- State: Durable Object `HeartbeatMonitor`
- Backup scheduler: cron trigger every minute
- Notifications: Discord, Telegram, Cloudflare Email Routing
- Validation: Zod

## Security

- All operational endpoints use bearer-token auth.
- Query-string auth is intentionally not supported.
- Only watchdog-style alerts refresh the heartbeat.
- Notification delivery is best-effort across all configured channels, with cooldown-based repeat alerts.
