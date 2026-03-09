# deadman

A Cloudflare Worker that acts as a **dead man's switch** for your Prometheus/Alertmanager alerting pipeline. It expects periodic [Watchdog](https://runbooks.prometheus-operator.dev/runbooks/general/watchdog/) heartbeats and alerts you through Discord, Telegram, or email if they stop arriving.

If your Prometheus or Alertmanager goes down, it can't alert you that it's down. Deadman solves this by running independently on Cloudflare Workers — if the expected heartbeat stops, it fires notifications through completely separate channels.

## How it works

```
Alertmanager (Watchdog alert) ──POST──▶ /webhook/alertmanager
                                              │
                                    Validates auth + payload
                                    Filters for Watchdog alert
                                              │
                                              ▼
                                   HeartbeatMonitor (Durable Object)
                                    Records timestamp, sets alarm
                                              │
                              ┌───────────────┴───────────────┐
                              ▼                               ▼
                     Alarm fires at                   Cron backup fires
                     now + timeout                    every minute
                              │                               │
                              └───────────────┬───────────────┘
                                              │
                                   elapsed > timeout?
                                              │
                                    ▼ YES               NO ▶ reschedule
                              Send notifications
                         (Discord / Telegram / Email)
```

1. Alertmanager sends its Watchdog alert to `/webhook/alertmanager` on a regular interval
2. The worker validates authentication and the payload, then records the heartbeat timestamp
3. A Durable Object alarm fires after the configured timeout (default: 5 minutes). A cron trigger every minute acts as a backup.
4. If the heartbeat has expired, notifications fire through all configured channels
5. When the heartbeat resumes, a recovery notification is sent

Only `Watchdog`, `DeadMansSwitch`, and `InfoInhibitor` alerts refresh the heartbeat — other Alertmanager alerts are ignored to prevent a partially broken pipeline from masking issues.

## Setup

### Prerequisites

- [Bun](https://bun.sh/) (or Node.js)
- A Cloudflare account with Workers enabled
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

### Install

```bash
bun install
```

### Configure secrets

An `AUTH_TOKEN` is required. Notification channels are optional — configure at least one.

```bash
wrangler secret put AUTH_TOKEN

# Discord (optional)
wrangler secret put DISCORD_WEBHOOK_URL

# Telegram (optional)
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID

# Email requires Cloudflare Email Routing enabled on your domain.
# Set EMAIL_FROM and EMAIL_TO in wrangler.toml [vars].
```

### Configure timeouts

Edit `wrangler.toml` `[vars]`:

| Variable | Default | Description |
|---|---|---|
| `HEARTBEAT_TIMEOUT_SECONDS` | `300` (5 min) | How long without a heartbeat before alerting |
| `ALERT_COOLDOWN_SECONDS` | `900` (15 min) | Minimum time between repeated alert notifications |

### Deploy

```bash
bun run deploy
```

### Configure Alertmanager

Add a webhook receiver to your Alertmanager config:

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

All endpoints except `/health` require authentication via `Authorization: Bearer <token>` header or `?token=<token>` query parameter.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | No | Returns `ok` — use for uptime checks |
| GET | `/status` | Yes | Returns heartbeat state (healthy/alerting/waiting) |
| POST | `/webhook/alertmanager` | Yes | Receives Alertmanager webhook payloads |
| GET | `/ping` | Yes | Simple heartbeat endpoint (accepts `?source=` param) |

### Status response

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

`status` is one of:
- **`waiting`** — no heartbeat ever received
- **`healthy`** — last heartbeat is within the timeout window
- **`alerting`** — heartbeat has expired

## Local development

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your secrets
bun run dev
```

Test the webhook:

```bash
# Send a heartbeat
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

# Check status
curl http://localhost:8787/status?token=change-me-to-a-secure-random-token

# Simple ping
curl http://localhost:8787/ping?token=change-me-to-a-secure-random-token
```

## Scripts

```bash
bun run dev         # Local development server (wrangler dev)
bun run deploy      # Deploy to Cloudflare Workers
bun run typecheck   # Type check with tsc
bun run test        # Run tests with bun test
bun run tail        # Stream logs from deployed worker
```
