import { DurableObject } from "cloudflare:workers";
import type { Env, HeartbeatState } from "./types.ts";
import { sendNotifications } from "./notify.ts";

const DEFAULT_TIMEOUT = 300; // 5 minutes
const DEFAULT_COOLDOWN = 900; // 15 minutes

export class HeartbeatMonitor extends DurableObject<Env> {
  private getTimeout(): number {
    const val = parseInt(this.env.HEARTBEAT_TIMEOUT_SECONDS || String(DEFAULT_TIMEOUT), 10);
    if (Number.isNaN(val) || val <= 0) {
      throw new Error(`Invalid HEARTBEAT_TIMEOUT_SECONDS: ${this.env.HEARTBEAT_TIMEOUT_SECONDS}`);
    }
    return val * 1000;
  }

  private getCooldown(): number {
    const val = parseInt(this.env.ALERT_COOLDOWN_SECONDS || String(DEFAULT_COOLDOWN), 10);
    if (Number.isNaN(val) || val <= 0) {
      throw new Error(`Invalid ALERT_COOLDOWN_SECONDS: ${this.env.ALERT_COOLDOWN_SECONDS}`);
    }
    return val * 1000;
  }

  private async getState(): Promise<HeartbeatState> {
    const state = await this.ctx.storage.get<HeartbeatState>("state");
    return state ?? { lastHeartbeat: 0, lastAlertSent: 0, isAlerting: false, source: "" };
  }

  private async setState(state: HeartbeatState): Promise<void> {
    await this.ctx.storage.put("state", state);
  }

  /** Called when Alertmanager sends a webhook (heartbeat received) */
  async recordHeartbeat(source: string): Promise<Response> {
    const now = Date.now();
    const state = await this.getState();
    const wasAlerting = state.isAlerting;

    state.lastHeartbeat = now;
    state.source = source;
    state.isAlerting = false;
    await this.setState(state);

    // Schedule alarm to check for heartbeat expiry
    await this.ctx.storage.setAlarm(now + this.getTimeout());

    if (wasAlerting) {
      console.log("Heartbeat recovered - alerting system is back online");
      try {
        await sendNotifications({
          title: "Deadman Switch - RECOVERED",
          message: `Alerting system is back online.\nSource: ${source}\nRecovered at: ${new Date(now).toISOString()}`,
          env: this.env,
          isRecovery: true,
        });
      } catch (e) {
        console.error("Failed to send recovery notification:", e);
      }
    }

    return new Response(JSON.stringify({ status: "ok", lastHeartbeat: now }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /** Called by the cron trigger to ensure alarm is set */
  async checkHeartbeat(): Promise<void> {
    const state = await this.getState();

    // If we've never received a heartbeat, nothing to check
    if (state.lastHeartbeat === 0) {
      console.log("No heartbeat ever received - skipping check");
      return;
    }

    const now = Date.now();
    const elapsed = now - state.lastHeartbeat;
    const timeout = this.getTimeout();

    if (elapsed > timeout) {
      await this.triggerAlert(state, now);
    }

    // Ensure alarm is always scheduled
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null) {
      await this.ctx.storage.setAlarm(now + timeout);
    }
  }

  /** Durable Object alarm handler - fires when heartbeat timeout expires */
  override async alarm(): Promise<void> {
    const state = await this.getState();
    const now = Date.now();
    const elapsed = now - state.lastHeartbeat;
    const timeout = this.getTimeout();

    if (state.lastHeartbeat > 0 && elapsed > timeout) {
      await this.triggerAlert(state, now);
    }

    // Re-schedule alarm to keep checking
    await this.ctx.storage.setAlarm(now + timeout);
  }

  private async triggerAlert(state: HeartbeatState, now: number): Promise<void> {
    const cooldown = this.getCooldown();
    const timeSinceLastAlert = now - state.lastAlertSent;

    if (state.isAlerting && timeSinceLastAlert < cooldown) {
      console.log(
        `Alert already sent ${Math.round(timeSinceLastAlert / 1000)}s ago, cooldown is ${cooldown / 1000}s`
      );
      return;
    }

    const elapsedMinutes = Math.round((now - state.lastHeartbeat) / 60000);

    console.error(
      `ALERT: No heartbeat for ${elapsedMinutes} minutes! Last source: ${state.source}`
    );

    try {
      await sendNotifications({
        title: "Deadman Switch - ALERTING SYSTEM DOWN",
        message: [
          `No heartbeat received for ${elapsedMinutes} minute(s).`,
          `Last heartbeat source: ${state.source || "unknown"}`,
          `Last heartbeat: ${state.lastHeartbeat ? new Date(state.lastHeartbeat).toISOString() : "never"}`,
          `Checked at: ${new Date(now).toISOString()}`,
          "",
          "Your Prometheus/Alertmanager alerting pipeline may be down!",
        ].join("\n"),
        env: this.env,
      });

      // Only suppress retries once we know at least one channel delivered
      state.isAlerting = true;
      state.lastAlertSent = now;
      await this.setState(state);
    } catch (e) {
      console.error("Failed to send alert notification:", e);
      // Do NOT set isAlerting/lastAlertSent so the next cycle retries
    }
  }

  /** Status endpoint - computes effective health from elapsed time */
  async getStatus(): Promise<Response> {
    const state = await this.getState();
    const now = Date.now();
    const timeout = this.getTimeout();
    const elapsed = state.lastHeartbeat ? now - state.lastHeartbeat : null;

    // Derive status from actual elapsed time, not just persisted isAlerting,
    // so /status stays truthful even if the alarm/cron is delayed.
    let status: string;
    if (!state.lastHeartbeat) {
      status = "waiting";
    } else if (elapsed! > timeout) {
      status = "alerting";
    } else {
      status = "healthy";
    }

    return new Response(
      JSON.stringify({
        status,
        lastHeartbeat: state.lastHeartbeat ? new Date(state.lastHeartbeat).toISOString() : null,
        elapsedSeconds: elapsed ? Math.round(elapsed / 1000) : null,
        timeoutSeconds: timeout / 1000,
        isAlerting: state.isAlerting,
        source: state.source,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }
}
