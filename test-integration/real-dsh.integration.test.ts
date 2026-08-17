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
import { WARMUP_QUERY } from "../src/warmup.js";
import {
  DAEMON_KEY,
  DAEMON_URL,
  DAEMON_USER,
  PING_TOOL,
  bootRuntime,
  hasSodaMemEvidence,
  textReply,
  toolCallReply,
  type RecordingAdapter,
} from "./runtime.js";
import { startRecordingProxy, startStallingDaemon, type RunningServer } from "./servers.js";

/** How the warm-up query appears in a request path, for filtering wire traffic. */
const WARMUP_QUERY_ENCODED = encodeURIComponent(WARMUP_QUERY).replace(/%20/g, "+");

const config = (apiUrl: string) => ({
  apiUrl,
  apiKey: DAEMON_KEY,
  userId: DAEMON_USER,
  tokenBudget: 1200,
});

/**
 * Two questions whose answers in the bench store do not overlap. Telling one
 * turn's recall from another's is the whole point of the recall tests, so a
 * shared top hit would make them prove nothing.
 */
const PET_QUERY = "do I have a pet?";
const PET_EVIDENCE = "golden retriever";
const FLIGHT_QUERY = "which airline did I fly to Boston?";
const FLIGHT_EVIDENCE = "flew United to Boston";

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
        adapter.evidenceText(i) === "" ? "no" : "YES"
      }`
  );
  // eslint-disable-next-line no-console
  console.log(`[${label}]\n${lines.join("\n")}`);
}

/** The first few evidence lines of one request, for the record. */
function excerpt(adapter: RecordingAdapter, index: number, lines = 2): string {
  return adapter
    .evidenceText(index)
    .split("\n")
    .filter((line) => line.startsWith("- evidence_id="))
    .slice(0, lines)
    .join("\n");
}

/** One direct `/v1/context`, bypassing the plugin. Returns the HTTP status. */
async function probe(query: string): Promise<number> {
  const url = new URL("/v1/context", DAEMON_URL);
  url.searchParams.set("user_id", DAEMON_USER);
  url.searchParams.set("query", query);
  url.searchParams.set("token_budget", "100");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${DAEMON_KEY}` } });
  await response.text();
  return response.status;
}

beforeAll(async () => {
  const response = await fetch(new URL("/health", DAEMON_URL)).catch(() => undefined);
  if (!response?.ok) {
    throw new Error(
      `no SodaMem daemon at ${DAEMON_URL}. Start it first — see test-integration/README.md`
    );
  }

  // Warm the daemon explicitly before ANY assertion.
  //
  // The daemon opens a user's store lazily, and that first request is slow and
  // currently panics (see src/warmup.ts). Leaving it to chance made this suite
  // pass warm and fail cold on its flagship recall assertion — a gate that
  // cries wolf is worse than no gate, so the state is established here rather
  // than depended upon.
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const status = await probe("integration suite warm-up");
    statuses.push(status);
    if (status === 200) break;
  }
  // eslint-disable-next-line no-console
  console.log(`[suite] daemon warm-up statuses: ${statuses.join(", ")}`);
  if (statuses[statuses.length - 1] !== 200) {
    throw new Error(`daemon at ${DAEMON_URL} never became ready: ${statuses.join(", ")}`);
  }
});

describe("recall reaches the model", () => {
  it("puts store evidence into the request for the turn that asked", async () => {
    const runtime = await bootRuntime(config(DAEMON_URL));
    try {
      await runtime.ask(PET_QUERY);
      report("recall / single turn", runtime.adapter);
      // eslint-disable-next-line no-console
      console.log(`--- request #0 evidence ---\n${excerpt(runtime.adapter, 0)}\n---`);

      expect(runtime.adapter.seen.length).toBe(1);
      expect(runtime.adapter.messageText(0)).toContain(PET_QUERY);
      expect(runtime.adapter.topEvidence(0)).toContain(PET_EVIDENCE);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  it("answers each turn's own question, not the previous one", async () => {
    const runtime = await bootRuntime(config(DAEMON_URL));
    try {
      await runtime.ask(PET_QUERY);
      await runtime.ask(FLIGHT_QUERY);
      report("recall / two turns", runtime.adapter);
      // eslint-disable-next-line no-console
      console.log(
        `--- turn 1 evidence ---\n${excerpt(runtime.adapter, 0)}\n` +
          `--- turn 2 evidence ---\n${excerpt(runtime.adapter, 1)}\n---`
      );

      // Turn 1 asked about pets and its best evidence is about pets.
      expect(runtime.adapter.topEvidence(0)).toContain(PET_EVIDENCE);
      // Turn 2 asked about the flight and its best evidence is about the
      // flight. This is the regression that made the plugin useless: turn 2
      // used to receive turn 1's block verbatim, answering the previous
      // question.
      expect(runtime.adapter.topEvidence(1)).toContain(FLIGHT_EVIDENCE);
      expect(runtime.adapter.topEvidence(1)).not.toContain(PET_EVIDENCE);
      // Two questions, two genuinely different recalls.
      expect(runtime.adapter.evidenceText(1)).not.toBe(runtime.adapter.evidenceText(0));
    } finally {
      await runtime.dispose();
    }
  }, 60_000);
});

describe("the plugin warms the path when it loads", () => {
  it("issues a warm-up request before any turn, so the first question is not the first request", async () => {
    const proxy = await startRecordingProxy(DAEMON_URL);
    const runtime = await bootRuntime(config(proxy.url));
    try {
      // Give the fire-and-forget warm-up room to land. Nothing waits on it in
      // production either — that is the point.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const warmups = proxy.requests.filter((r) => r.path.includes(WARMUP_QUERY_ENCODED));
      // eslint-disable-next-line no-console
      console.log(`[warm-up] ${warmups.length} request(s) before the first turn`);
      expect(warmups.length).toBeGreaterThanOrEqual(1);

      // And the turn that follows still recalls for its own question.
      await runtime.ask(PET_QUERY);
      expect(runtime.adapter.topEvidence(0)).toContain(PET_EVIDENCE);
    } finally {
      await runtime.dispose();
      await proxy.close();
    }
  }, 60_000);
});

describe("recall costs one request per question", () => {
  it("does not re-ask the daemon on every step of a tool loop", async () => {
    // A real proxy in front of the real daemon, purely to count wire traffic.
    const proxy = await startRecordingProxy(DAEMON_URL);
    const runtime = await bootRuntime(config(proxy.url), { withTool: true });
    try {
      // Request 0 calls the tool; the loop dispatches it and comes back for
      // request 1 in the SAME turn. Both steps assemble a prompt.
      runtime.adapter.script = [toolCallReply("call-1", PING_TOOL), textReply("done")];
      await runtime.ask(PET_QUERY);

      const recalls = proxy.requests.filter(
        (r) => r.path.startsWith("/v1/context") && !r.path.includes(WARMUP_QUERY_ENCODED)
      );
      report(`tool loop (${recalls.length} recall requests)`, runtime.adapter);

      // Two model requests in one turn...
      expect(runtime.adapter.seen.length).toBe(2);
      // ...and exactly one recall for the one question that was asked.
      expect(recalls.length).toBe(1);
      // Both steps still see the memory.
      expect(runtime.adapter.topEvidence(0)).toContain(PET_EVIDENCE);
      expect(runtime.adapter.topEvidence(1)).toContain(PET_EVIDENCE);
    } finally {
      await runtime.dispose();
      await proxy.close();
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

  it("sends the closed turn's authored prose, and never its own recall", async () => {
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

    const write = proxy.requests.find(
      (r) => r.method === "POST" && r.path.startsWith("/v1/memories")
    );
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
    // Exactly the human's question and the model's reply. The runtime-context
    // snapshot carrying SodaMem's own evidence must NOT be here: ingesting it
    // would feed the store its own output back on every turn.
    expect(body.messages).toEqual([
      { role: "user", content: PET_QUERY },
      { role: "assistant", content: "ok" },
    ]);
    expect(write!.body).not.toContain("evidence_id=");
  }, 60_000);
});
