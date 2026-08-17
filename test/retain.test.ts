import { afterEach, describe, expect, it, vi } from "vitest";
import { apply, collectTurnMessages } from "../src/index.js";
import {
  CONFIG,
  assistantMessage,
  createFakeContext,
  fakeSession,
  installAcceptedFetch,
  installStallingBodyFetch,
  installUncancellableBodyFetch,
  installUnreachableFetch,
  snapshotMessage,
  textBlocks,
  toolResultMessage,
  userMessage,
  type FakeEvent,
  type FetchDouble,
} from "./harness.js";

let fetchDouble: FetchDouble | undefined;

afterEach(() => {
  fetchDouble?.restore();
  fetchDouble = undefined;
  vi.useRealTimers();
});

function turnStopping(fake: ReturnType<typeof createFakeContext>) {
  const listener = fake.listeners.get("agent/turn-stopping");
  if (!listener) throw new Error("agent/turn-stopping was not registered");
  return listener as unknown as (payload: unknown) => Promise<void>;
}

/** Turn 1 is closed; turn 2 has already opened above it in the log. */
function closedTurnEvents(): FakeEvent[] {
  return [
    { type: "turn/start", data: { turn: 1 } },
    { type: "user/message", data: {}, message: userMessage("I live in Shenzhen.") },
    { type: "assistant/chunk", data: { turn: 1, step: 1 } },
    { type: "assistant/message", data: {}, message: assistantMessage("Noted — Shenzhen.") },
    { type: "tool/result", data: {}, message: { role: "user", content: textBlocks("") } },
    { type: "step/end", data: { turn: 1, step: 1 } },
  ];
}

describe("retain", () => {
  it("registers agent/turn-stopping", () => {
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);
    expect(fake.listeners.has("agent/turn-stopping")).toBe(true);
  });

  it("on turn close, POST /v1/memories carries the turn's user+assistant messages with session_id = agent.id", async () => {
    fetchDouble = installAcceptedFetch();
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    await turnStopping(fake)({
      agent: { id: "session-42", session: fakeSession(closedTurnEvents()) },
      turn: 1,
      signal: new AbortController().signal,
    });

    expect(fetchDouble.recallCalls).toHaveLength(1);
    const call = fetchDouble.recallCalls[0]!;
    expect(call.method).toBe("POST");
    expect(new URL(call.url).pathname).toBe("/v1/memories");

    const body = JSON.parse(call.body!) as Record<string, unknown>;
    expect(body.user_id).toBe("aaron");
    expect(body.session_id).toBe("session-42");
    // agent_id is deliberately NOT sent: it would be the session id, which
    // would fragment recall across sessions.
    expect(body).not.toHaveProperty("agent_id");
    expect(body.messages).toEqual([
      { role: "user", content: "I live in Shenzhen." },
      { role: "assistant", content: "Noted — Shenzhen." },
    ]);
  });

  it("slices only the closed turn out of the log", () => {
    const events: FakeEvent[] = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: {}, message: userMessage("older turn") },
      { type: "turn/end", data: { turn: 1, reason: "complete" } },
      { type: "turn/start", data: { turn: 2 } },
      { type: "user/message", data: {}, message: userMessage("current turn") },
    ];
    expect(collectTurnMessages(fakeSession(events), 2)).toEqual([
      { role: "user", content: "current turn" },
    ]);
  });

  it("ingests nothing when the turn produced no text", async () => {
    fetchDouble = installAcceptedFetch();
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    await turnStopping(fake)({
      agent: {
        id: "session-42",
        session: fakeSession([
          { type: "turn/start", data: { turn: 1 } },
          { type: "step/end", data: { turn: 1, step: 1 } },
        ]),
      },
      turn: 1,
      signal: new AbortController().signal,
    });

    expect(fetchDouble.recallCalls).toHaveLength(0);
  });

  it("a second turn-stopping for the same turn does not re-ingest the same prose", async () => {
    fetchDouble = installAcceptedFetch();
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    // The loop re-enters a turn when a listener queues next-step work, and
    // collectTurnMessages always slices from turn/start — so without a guard
    // the same prose is written twice into the user's store.
    const payload = {
      agent: { id: "session-42", session: fakeSession(closedTurnEvents()) },
      turn: 1,
      signal: new AbortController().signal,
    };
    await turnStopping(fake)(payload);
    await turnStopping(fake)(payload);

    expect(fetchDouble.recallCalls).toHaveLength(1);
  });

  it("ingests only the tail when a re-entered turn really did produce more", async () => {
    fetchDouble = installAcceptedFetch();
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    const events = closedTurnEvents();
    const session = { events, deriveEventMessage: (e: FakeEvent) => e.message ?? null };
    const payload = {
      agent: { id: "session-42", session: session as never },
      turn: 1,
      signal: new AbortController().signal,
    };

    await turnStopping(fake)(payload);
    expect(fetchDouble.recallCalls).toHaveLength(1);

    // The turn continued and said one more thing.
    events.push({ type: "user/message", data: {}, message: userMessage("one more thing") });
    await turnStopping(fake)(payload);

    expect(fetchDouble.recallCalls).toHaveLength(2);
    const second = JSON.parse(fetchDouble.recallCalls[1]!.body!) as { messages: unknown[] };
    expect(second.messages).toEqual([{ role: "user", content: "one more thing" }]);
  });

  it("never ingests its own recalled evidence back into SodaMem", () => {
    // The runtime-context snapshot is `role: 'user'` and carries the evidence
    // block THIS plugin just recalled. Ingesting it would feed the store its
    // own output on every turn, and each recall would be re-extracted as fresh
    // facts for the next one to return.
    const events: FakeEvent[] = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: {}, message: userMessage("do I have a pet?") },
      {
        type: "user/message",
        data: {},
        message: snapshotMessage(
          "Current runtime context.\n\n- evidence_id=ev_fact:1 support=I adopted a corgi."
        ),
      },
      { type: "tool/result", data: {}, message: toolResultMessage("pong") },
      { type: "assistant/message", data: {}, message: assistantMessage("You have a corgi.") },
    ];

    expect(collectTurnMessages(fakeSession(events), 1)).toEqual([
      { role: "user", content: "do I have a pet?" },
      { role: "assistant", content: "You have a corgi." },
    ]);
  });

  it("ingests nothing when the turn's turn/start is not in the log", () => {
    expect(collectTurnMessages(fakeSession(closedTurnEvents()), 99)).toEqual([]);
  });

  it("never lets a SodaMem failure escape into the user's turn", async () => {
    fetchDouble = installUnreachableFetch();
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    await expect(
      turnStopping(fake)({
        agent: { id: "session-42", session: fakeSession(closedTurnEvents()) },
        turn: 1,
        signal: new AbortController().signal,
      })
    ).resolves.toBeUndefined();

    expect(fake.logs.some((entry) => entry.level === "warn")).toBe(true);
  });

  it("stalled response BODY: the 5000ms deadline ends the wait, so turn-stopping cannot hang the machine", async () => {
    vi.useFakeTimers();
    fetchDouble = installStallingBodyFetch();
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    let settled = false;
    const pending = turnStopping(fake)({
      agent: { id: "session-42", session: fakeSession(closedTurnEvents()) },
      turn: 1,
      signal: new AbortController().signal,
    }).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(settled).toBe(true);
    expect(fetchDouble.recallCalls[0]!.signal?.aborted).toBe(true);
    const error = fake.logs.find((entry) => entry.level === "warn")!.args[1] as Error;
    expect(error.name).toBe("SodaMemDeadlineError");
    expect(error.message).toContain("5000ms");
  });

  it("stalled body on a transport that ignores the signal: the deadline still ends the wait", async () => {
    vi.useFakeTimers();
    fetchDouble = installUncancellableBodyFetch();
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    const pending = turnStopping(fake)({
      agent: { id: "session-42", session: fakeSession(closedTurnEvents()) },
      turn: 1,
      signal: new AbortController().signal,
    });

    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBeUndefined();
  });
});
