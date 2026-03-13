import { mock } from "bun:test";

export function mockCloudflareWorkers() {
  mock.module("cloudflare:workers", () => ({
    DurableObject: class DurableObject<T> {
      constructor(
        public ctx: unknown,
        public env: T
      ) {}
    },
  }));
}
