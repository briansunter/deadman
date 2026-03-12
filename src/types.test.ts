import { describe, expect, test } from "bun:test";
import { AlertmanagerPayloadSchema } from "./types.ts";

describe("AlertmanagerPayloadSchema", () => {
  test("accepts minimal valid payload", () => {
    const result = AlertmanagerPayloadSchema.safeParse({
      alerts: [{ status: "firing", labels: { alertname: "Watchdog" } }],
    });
    expect(result.success).toBe(true);
  });

  test("accepts resolved status", () => {
    const result = AlertmanagerPayloadSchema.safeParse({
      alerts: [{ status: "resolved", labels: { alertname: "Watchdog" } }],
    });
    expect(result.success).toBe(true);
  });

  test("accepts multiple alerts", () => {
    const result = AlertmanagerPayloadSchema.safeParse({
      alerts: [
        { status: "firing", labels: { alertname: "Watchdog" } },
        { status: "firing", labels: { alertname: "HighCPU", severity: "critical" } },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts extra fields on the root (loose schema)", () => {
    const result = AlertmanagerPayloadSchema.safeParse({
      version: "4",
      groupKey: "{}:{alertname=\"Watchdog\"}",
      status: "firing",
      receiver: "deadman",
      alerts: [{ status: "firing", labels: { alertname: "Watchdog" } }],
    });
    expect(result.success).toBe(true);
  });

  test("accepts extra fields on alert objects (loose schema)", () => {
    const result = AlertmanagerPayloadSchema.safeParse({
      alerts: [{
        status: "firing",
        labels: { alertname: "Watchdog", severity: "none" },
        annotations: { message: "Watchdog alert" },
        startsAt: "2026-03-12T00:00:00.000Z",
        endsAt: "0001-01-01T00:00:00Z",
        generatorURL: "http://prometheus:9090/graph",
        fingerprint: "abc123",
      }],
    });
    expect(result.success).toBe(true);
  });

  test("accepts multiple labels", () => {
    const result = AlertmanagerPayloadSchema.safeParse({
      alerts: [{
        status: "firing",
        labels: {
          alertname: "Watchdog",
          severity: "none",
          namespace: "monitoring",
          prometheus: "kube-prometheus-stack",
        },
      }],
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty alerts array", () => {
    const result = AlertmanagerPayloadSchema.safeParse({ alerts: [] });
    expect(result.success).toBe(false);
  });

  test("rejects missing alerts field", () => {
    const result = AlertmanagerPayloadSchema.safeParse({ status: "firing" });
    expect(result.success).toBe(false);
  });

  test("rejects invalid status value", () => {
    const result = AlertmanagerPayloadSchema.safeParse({
      alerts: [{ status: "pending", labels: { alertname: "Watchdog" } }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing labels", () => {
    const result = AlertmanagerPayloadSchema.safeParse({
      alerts: [{ status: "firing" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing status", () => {
    const result = AlertmanagerPayloadSchema.safeParse({
      alerts: [{ labels: { alertname: "Watchdog" } }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-string label values", () => {
    const result = AlertmanagerPayloadSchema.safeParse({
      alerts: [{ status: "firing", labels: { alertname: 123 } }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-object payload", () => {
    expect(AlertmanagerPayloadSchema.safeParse("string").success).toBe(false);
    expect(AlertmanagerPayloadSchema.safeParse(123).success).toBe(false);
    expect(AlertmanagerPayloadSchema.safeParse(null).success).toBe(false);
    expect(AlertmanagerPayloadSchema.safeParse(undefined).success).toBe(false);
  });

  test("rejects alerts as non-array", () => {
    const result = AlertmanagerPayloadSchema.safeParse({
      alerts: "not an array",
    });
    expect(result.success).toBe(false);
  });
});
