import type { Env } from "./types.ts";
import { AlertmanagerPayloadSchema } from "./types.ts";
import { verifyAuth } from "./auth.ts";
import { assertRuntimeConfig } from "./config.ts";

export { HeartbeatMonitor } from "./heartbeat-monitor.ts";

const MONITOR_ID = "singleton";
const MAX_PING_SOURCE_LENGTH = 128;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const PROTECTED_PATHS = new Set([
  "/status",
  "/ping",
  "/webhook/alertmanager",
  "/reset",
]);

function getMonitor(env: Env) {
  const id = env.HEARTBEAT_MONITOR.idFromName(MONITOR_ID);
  return env.HEARTBEAT_MONITOR.get(id);
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function methodNotAllowed(allowed: string): Response {
  return json({ error: "Method Not Allowed" }, 405, { Allow: allowed });
}

function isProtectedPath(path: string): boolean {
  return PROTECTED_PATHS.has(path);
}

function parsePingSource(url: URL): { source: string } | { error: Response } {
  const rawSource = url.searchParams.get("source");
  if (rawSource === null) {
    return { source: "ping" };
  }

  const source = rawSource.trim();
  if (!source) {
    return { source: "ping" };
  }

  if (source.length > MAX_PING_SOURCE_LENGTH) {
    return {
      error: json(
        { error: `source must be ${MAX_PING_SOURCE_LENGTH} characters or fewer` },
        400
      ),
    };
  }

  if (CONTROL_CHARACTER_PATTERN.test(source)) {
    return { error: json({ error: "source must not contain control characters" }, 400) };
  }

  return { source };
}

function misconfigured(error: unknown): Response {
  console.error("Service misconfigured:", error);
  return json({ error: "Service misconfigured" }, 500);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check - no auth needed
    if (path === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed("GET, HEAD");
      }
      return new Response(request.method === "HEAD" ? null : "ok");
    }

    if (path === "/status" && request.method !== "GET") {
      return methodNotAllowed("GET");
    }

    if (path === "/ping" && request.method !== "GET") {
      return methodNotAllowed("GET");
    }

    if (path === "/webhook/alertmanager" && request.method !== "POST") {
      return methodNotAllowed("POST");
    }

    if (path === "/reset" && request.method !== "POST") {
      return methodNotAllowed("POST");
    }

    if (!isProtectedPath(path)) {
      return json({ error: "Not Found" }, 404);
    }

    if (!env.AUTH_TOKEN?.trim()) {
      return misconfigured("AUTH_TOKEN is required");
    }

    // All other endpoints require auth
    if (!(await verifyAuth(request, env))) {
      return json({ error: "Unauthorized" }, 401);
    }

    try {
      assertRuntimeConfig(env);
    } catch (error) {
      return misconfigured(error);
    }

    // Status endpoint
    if (path === "/status") {
      const monitor = getMonitor(env);
      return monitor.getStatus();
    }

    // Alertmanager webhook receiver
    if (path === "/webhook/alertmanager") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      const result = AlertmanagerPayloadSchema.safeParse(body);
      if (!result.success) {
        console.error("Invalid alertmanager payload:", result.error.issues);
        return json({ error: "Invalid payload" }, 400);
      }

      const payload = result.data;

      // Only dedicated deadman/watchdog alerts should refresh the heartbeat.
      // Accepting arbitrary firing alerts would mask a broken alerting pipeline.
      const watchdogAlert = payload.alerts.find(
        (alert) =>
          alert.status === "firing" &&
          (alert.labels.alertname === "Watchdog" ||
            alert.labels.alertname === "DeadMansSwitch" ||
            alert.labels.alertname === "InfoInhibitor")
      );

      if (watchdogAlert) {
        const source = `alertmanager:${watchdogAlert.labels.alertname}`;
        const monitor = getMonitor(env);
        return monitor.recordHeartbeat(source);
      }

      return json({ status: "ignored", reason: "no watchdog alert firing" });
    }

    // Reset endpoint - clear state back to "waiting"
    if (path === "/reset") {
      const monitor = getMonitor(env);
      return monitor.resetState();
    }

    // Simple ping endpoint (for testing or custom integrations)
    if (path === "/ping") {
      const sourceResult = parsePingSource(url);
      if ("error" in sourceResult) {
        return sourceResult.error;
      }

      const monitor = getMonitor(env);
      return monitor.recordHeartbeat(sourceResult.source);
    }

    return json({ error: "Not Found" }, 404);
  },

} satisfies ExportedHandler<Env>;
