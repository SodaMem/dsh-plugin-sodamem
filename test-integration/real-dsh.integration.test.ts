/**
 * The plugin inside a REAL DeepSeek Harness runtime, talking to a REAL SodaMem
 * daemon over HTTP.
 *
 * Everything is real except the LLM adapter (see `runtime.ts`). Run with a
 * populated daemon on `SODAMEM_TEST_URL`:
 *
 *     npm run test:integration
 *
 * CI does not run this file — it is a separate vitest project.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECALL_TIMEOUT_MS, RETAIN_TIMEOUT_MS } from "../src/config.js";
import {
  DAEMON_KEY,
  DAEMON_URL,
  DAEMON_USER,
  bootRuntime,
  hasSodaMemEvidence,
  type RecordingAdapter,
} from "./runtime.js";
import { startRecordingProxy, startStallingDaemon, type RunningServer } from "./servers.js";

const config = (apiUrl: string) => ({
  apiUrl,
  apiKey: DAEMON_KEY,
  userId: DAEMON_USER,
  tokenBudget: 1200,
});

/** Distinctive store content, used to tell one turn's recall from another's. */
const PET_QUERY = "do I have a pet?";
const PET_EVIDENCE = "golden retriever";
const FLIGHT_QUERY = "which airline did I fly to Boston?";

async function adminRequestCount(route: string): Promise<number> {
  const url = new URL("/v1/admin/requests", DAEMON_URL);
  url.searchParams.set("limit", "1");
  url.searchParams.set("route", route);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${DAEMON_KEY}` } });
  const body = (await response.json()) as { total: number };
  return body.total;
}

function report(label: string, adapter: RecordingAdapter): void {
  const lines = adapter.seen.map(
    (call, i) =>
      `  request #${i}: ${call.messages.length} messages, sodamem evidence: ${
        adapter.messageText(i).includes("evidence_id=") ? "YES" : "no"
      }`
  );
  // eslint-disable-next-line no-console
  console.log(`[${label}]\n${lines.join("\n")}`);
}

beforeAll(async () => {
  const response = await fetch(new URL("/health", DAEMON_URL)).catch(() => undefined);
  if (!response?.ok) {
    throw new Error(
      `no SodaMem daemon at ${DAEMON_URL}. Start it first — see test-integration/README.md`
    );
  }
});

describe("recall reaches the model", () => {
  it("puts store evidence into the request for the turn that asked", async () => {
    const runtime = await bootRuntime(config(DAEMON_URL));
    try {
      await runtime.ask(PET_QUERY);

      const turnOne = runtime.adapter.messageText(0);
      report("recall / single turn", runtime.adapter);
      // eslint-disable-next-line no-console
      console.log(`--- assembled request #0 ---\n${turnOne}\n---`);

      expect(runtime.adapter.seen.length).toBe(1);
      expect(turnOne).toContain(PET_EVIDENCE);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  it("documents WHERE the evidence actually lands (turn N+1, not turn N)", async () => {
    const runtime = await bootRuntime(config(DAEMON_URL));
    try {
      await runtime.ask(PET_QUERY);
      await runtime.ask(FLIGHT_QUERY);
      report("recall / two turns", runtime.adapter);

      const turnOne = runtime.adapter.messageText(0);
      const turnTwo = runtime.adapter.messageText(1);
      // eslint-disable-next-line no-console
      console.log(`--- assembled request #1 (first 900 chars) ---\n${turnTwo.slice(0, 900)}\n---`);

      // The observed defect, asserted so a future fix makes this test fail loudly:
      // turn 1 got nothing, and turn 2 carries turn 1's PET evidence rather than
      // the flight evidence its own question asked for.
      expect(turnOne).not.toContain("evidence_id=");
      expect(turnTwo).toContain(PET_EVIDENCE);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);
});

describe("the turn survives SodaMem being down", () => {
  it("completes normally with no memory and no throw", async () => {
    // Port 1 is never a SodaMem daemon; connect() fails immediately.
    const runtime = await bootRuntime(config("http://127.0.0.1:1"));
    try {
      await runtime.ask(PET_QUERY);
      await runtime.ask(FLIGHT_QUERY);
      report("daemon down", runtime.adapter);

      expect(runtime.adapter.seen.length).toBe(2);
      expect(hasSodaMemEvidence(runtime.adapter)).toBe(false);
      expect(runtime.adapter.messageText(1)).toContain(FLIGHT_QUERY);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);
});

describe("the turn survives a stalled daemon", () => {
  let stalled: RunningServer;

  beforeAll(async () => {
    stalled = await startStallingDaemon();
  });
  afterAll(async () => {
    await stalled?.close();
  });

  it("bounds the whole call and completes the turn anyway", async () => {
    const runtime = await bootRuntime(config(stalled.url));
    try {
      const started = Date.now();
      await runtime.ask(PET_QUERY);
      const elapsed = Date.now() - started;
      report(`stalled daemon (${elapsed}ms)`, runtime.adapter);

      expect(runtime.adapter.seen.length).toBe(1);
      expect(hasSodaMemEvidence(runtime.adapter)).toBe(false);
      // Both deadlines held. The turn pays recall's deadline before the request
      // and retain's after it, and nothing else — against undici's own 300s
      // body timeout this whole turn would otherwise never have returned.
      expect(elapsed).toBeGreaterThanOrEqual(RECALL_TIMEOUT_MS - 200);
      expect(elapsed).toBeLessThan(RECALL_TIMEOUT_MS + RETAIN_TIMEOUT_MS + 3_000);
    } finally {
      await runtime.dispose();
    }
  }, 120_000);
});

describe("retain fires", () => {
  it("issues POST /v1/memories to the real daemon on turn close", async () => {
    const before = await adminRequestCount("/v1/memories");
    const runtime = await bootRuntime(config(DAEMON_URL));
    try {
      await runtime.ask(PET_QUERY);
    } finally {
      await runtime.dispose();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await adminRequestCount("/v1/memories");
    // eslint-disable-next-line no-console
    console.log(`[retain] POST /v1/memories count ${before} -> ${after}`);
    expect(after).toBeGreaterThan(before);
  }, 60_000);

  it("sends the closed turn's user and assistant prose as the body", async () => {
    // A real reverse proxy in front of the real daemon: the daemon still
    // receives and processes the write; the proxy only reads the bytes.
    const proxy = await startRecordingProxy(DAEMON_URL);
    const runtime = await bootRuntime(config(proxy.url));
    try {
      await runtime.ask(PET_QUERY);
    } finally {
      await runtime.dispose();
      await proxy.close();
    }

    const write = proxy.requests.find((r) => r.method === "POST" && r.path.startsWith("/v1/memories"));
    // eslint-disable-next-line no-console
    console.log(`[retain] wire body:\n${write?.body}`);
    expect(write).toBeDefined();

    const body = JSON.parse(write!.body) as {
      user_id: string;
      session_id: string;
      messages: { role: string; content: string }[];
    };
    expect(body.user_id).toBe(DAEMON_USER);
    expect(body.session_id).toMatch(/^integration-/);
    expect(body.messages).toEqual([
      { role: "user", content: PET_QUERY },
      { role: "assistant", content: "ok" },
    ]);
  }, 60_000);
});
