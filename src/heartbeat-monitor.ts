import { DurableObject } from "cloudflare:workers";
import {
  getAlertCooldownMs,
  getHeartbeatTimeoutMs,
  renderAlertTitle,
  renderAlertMessage,
  renderRecoveryTitle,
  renderRecoveryMessage,
  type AlertTemplateVars,
} from "./config.ts";
import type { Env, HeartbeatState } from "./types.ts";
import { sendNotifications } from "./notify.ts";

export class HeartbeatMonitor extends DurableObject<Env> {
  private getTimeout(): number {
    return getHeartbeatTimeoutMs(this.env);
  }

  private getCooldown(): number {
    return getAlertCooldownMs(this.env);
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
      const vars: AlertTemplateVars = {
        elapsed_minutes: "0",
        source,
        last_heartbeat: new Date(now).toISOString(),
        checked_at: new Date(now).toISOString(),
      };
      try {
        await sendNotifications({
          title: renderRecoveryTitle(this.env, vars),
          message: renderRecoveryMessage(this.env, vars),
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

    const vars: AlertTemplateVars = {
      elapsed_minutes: String(elapsedMinutes),
      source: state.source || "unknown",
      last_heartbeat: state.lastHeartbeat ? new Date(state.lastHeartbeat).toISOString() : "never",
      checked_at: new Date(now).toISOString(),
    };

    try {
      await sendNotifications({
        title: renderAlertTitle(this.env, vars),
        message: renderAlertMessage(this.env, vars),
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

  /** Reset state - returns to "waiting for first heartbeat" mode */
  async resetState(): Promise<Response> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete("state");
    return new Response(JSON.stringify({ status: "reset", message: "Waiting for first heartbeat" }), {
      headers: { "Content-Type": "application/json" },
    });
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
