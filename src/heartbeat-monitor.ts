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
import { json } from "./response.ts";
import type { Env, HeartbeatState } from "./types.ts";
import { sendNotifications } from "./notify.ts";

/**
 * Fallback retry interval used when alarm processing itself fails (malformed
 * config, storage error). Keeps the alarm loop alive instead of silently
 * terminating, while surfacing the problem via console.error.
 */
const ALARM_RETRY_INTERVAL_MS = 60_000;

export class HeartbeatMonitor extends DurableObject<Env> {
	private getTimeout(): number {
		return getHeartbeatTimeoutMs(this.env);
	}

	private getCooldown(): number {
		return getAlertCooldownMs(this.env);
	}

	private async getState(): Promise<HeartbeatState> {
		const state = await this.ctx.storage.get<HeartbeatState>("state");
		return (
			state ?? {
				lastHeartbeat: 0,
				lastAlertSent: 0,
				isAlerting: false,
				source: "",
			}
		);
	}

	private async setState(state: HeartbeatState): Promise<void> {
		await this.ctx.storage.put("state", state);
	}

	/** Called when Alertmanager sends a webhook (heartbeat received) */
	async recordHeartbeat(source: string): Promise<Response> {
		const now = Date.now();
		const state = await this.getState();
		const wasAlerting = state.isAlerting;

		// Persist the fresh heartbeat timestamp/source and re-arm the alarm, but do
		// NOT clear isAlerting until the recovery notification is confirmed
		// delivered. If recovery sendNotifications() fails, a later heartbeat must
		// retry the recovery notification rather than silently dropping it.
		state.lastHeartbeat = now;
		state.source = source;
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
				// Recovery delivered; now it is safe to clear the alerting state.
				state.isAlerting = false;
				await this.setState(state);
			} catch (e) {
				console.error("Failed to send recovery notification:", e);
				// Leave isAlerting set so the next heartbeat retries recovery delivery.
			}
		}

		return json({ status: "ok", lastHeartbeat: now });
	}

	/** Durable Object alarm handler - fires when heartbeat timeout expires */
	override async alarm(): Promise<void> {
		const now = Date.now();
		let nextAlarmAt: number;

		try {
			const state = await this.getState();

			// Preserve the existing cold-start behavior: if no heartbeat has ever
			// been recorded, do not auto-arm. (Changing this is a product decision
			// deferred to a separate pass.)
			if (!state.lastHeartbeat) {
				return;
			}

			const timeout = this.getTimeout();
			const elapsed = now - state.lastHeartbeat;

			if (elapsed >= timeout) {
				await this.triggerAlert(state, now);
				nextAlarmAt = now + timeout;
			} else {
				// Keep the alarm anchored to heartbeat expiry, not to an early/stale
				// alarm event, so a prematurely-delivered alarm still fires on time.
				nextAlarmAt = state.lastHeartbeat + timeout;
			}
		} catch (e) {
			console.error("Alarm processing failed; scheduling retry:", e);
			nextAlarmAt = now + ALARM_RETRY_INTERVAL_MS;
		}

		// Finalization: always reschedule so the alarm loop never silently dies.
		// A storage failure here is an infrastructure error we cannot recover from
		// inside the handler; let it propagate rather than swallowing it.
		await this.ctx.storage.setAlarm(nextAlarmAt);
	}

	private async triggerAlert(
		state: HeartbeatState,
		now: number,
	): Promise<void> {
		try {
			// Cooldown evaluation lives inside the try so a malformed runtime
			// configuration (e.g. non-numeric ALERT_COOLDOWN_SECONDS) cannot escape
			// and break the alarm loop; the catch path lets the next cycle retry.
			const cooldown = this.getCooldown();
			const timeSinceLastAlert = now - state.lastAlertSent;

			if (state.isAlerting && timeSinceLastAlert < cooldown) {
				console.log(
					`Alert already sent ${Math.round(timeSinceLastAlert / 1000)}s ago, cooldown is ${cooldown / 1000}s`,
				);
				return;
			}

			const elapsedMinutes = Math.round((now - state.lastHeartbeat) / 60000);

			console.error(
				`ALERT: No heartbeat for ${elapsedMinutes} minutes! Last source: ${state.source}`,
			);

			const vars: AlertTemplateVars = {
				elapsed_minutes: String(elapsedMinutes),
				source: state.source || "unknown",
				last_heartbeat: state.lastHeartbeat
					? new Date(state.lastHeartbeat).toISOString()
					: "never",
				checked_at: new Date(now).toISOString(),
			};

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
		return json({ status: "reset", message: "Waiting for first heartbeat" });
	}

	/** Status endpoint - computes effective health from elapsed time */
	async getStatus(): Promise<Response> {
		const state = await this.getState();
		const now = Date.now();
		const timeout = this.getTimeout();
		// Derive status from actual elapsed time, not just persisted isAlerting,
		// so /status stays truthful even if the alarm is delayed.
		let status: string;
		let elapsed: number | null;
		if (!state.lastHeartbeat) {
			status = "waiting";
			elapsed = null;
		} else {
			elapsed = now - state.lastHeartbeat;
			status = elapsed >= timeout ? "alerting" : "healthy";
		}

		return json({
			status,
			lastHeartbeat: state.lastHeartbeat
				? new Date(state.lastHeartbeat).toISOString()
				: null,
			elapsedSeconds: elapsed !== null ? Math.round(elapsed / 1000) : null,
			timeoutSeconds: timeout / 1000,
			isAlerting: state.isAlerting,
			source: state.source,
		});
	}
}
