import { afterEach, describe, expect, it, vi } from "vitest";
import { WARMUP_ATTEMPTS, WARMUP_QUERY, WARMUP_TOKEN_BUDGET, apply } from "../src/index.js";
import {
  CONFIG,
  createFakeContext,
  installContextFetch,
  installFetch,
  installUnreachableFetch,
  type FetchDouble,
} from "./harness.js";

let fetchDouble: FetchDouble | undefined;

afterEach(() => {
  fetchDouble?.restore();
  fetchDouble = undefined;
  vi.useRealTimers();
});

/** Let the fire-and-forget warm-up settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const warmupCalls = (double: FetchDouble) =>
  double.calls.filter(
    (call) => new URL(call.url).searchParams.get("query") === WARMUP_QUERY
  );

describe("warm-up", () => {
  it("asks the daemon once on load, so the user's first question is not the first request", async () => {
    fetchDouble = installContextFetch("hot");
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);
    await settle();

    const calls = warmupCalls(fetchDouble);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/context");
    expect(url.searchParams.get("user_id")).toBe(CONFIG.userId);
    // The cheapest request the daemon accepts: this is not a real recall.
    expect(url.searchParams.get("token_budget")).toBe(String(WARMUP_TOKEN_BUDGET));
  });

  it("does not block apply(), and apply() does not throw when no daemon is running", () => {
    fetchDouble = installUnreachableFetch();
    const fake = createFakeContext();

    // Booting with no daemon is an ordinary way to start.
    expect(() => apply(fake.ctx, CONFIG)).not.toThrow();
  });

  it("retries once when the first request fails, so a daemon still coming up is not fatal", async () => {
    let attempts = 0;
    fetchDouble = installFetch(() => {
      attempts++;
      if (attempts === 1) {
        return { ok: false, status: 500, statusText: "Internal Server Error", text: async () => "" };
      }
      return {
        ok: true,
        status: 200,
        statusText: "",
        text: async () => JSON.stringify({ text: "hot" }),
      };
    });
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);
    await settle();
    await settle();

    expect(warmupCalls(fetchDouble)).toHaveLength(WARMUP_ATTEMPTS);
  });

  it("gives up quietly rather than retrying forever when the daemon stays down", async () => {
    fetchDouble = installUnreachableFetch();
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);
    await settle();
    await settle();
    await settle();

    expect(warmupCalls(fetchDouble).length).toBeLessThanOrEqual(WARMUP_ATTEMPTS);
    // Degradation is a debug detail, not a warning in the user's face.
    expect(fake.logs.some((entry) => entry.level === "warn")).toBe(false);
  });

  it("stops when the plugin unloads", async () => {
    fetchDouble = installUnreachableFetch();
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);
    fake.unload();
    await settle();
    await settle();
    await settle();

    // The first attempt was already in flight; the retry must not follow it.
    expect(warmupCalls(fetchDouble).length).toBeLessThan(WARMUP_ATTEMPTS + 1);
  });
});
