import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_QUERY_CHARS, apply, capQuery, sanitizeContextText } from "../src/index.js";
import {
  CONFIG,
  assemble,
  claim,
  contributedText,
  createFakeContext,
  installContextFetch,
  installFetch,
  installHangingFetch,
  installStallingBodyFetch,
  installUncancellableBodyFetch,
  installUnreachableFetch,
  type FetchDouble,
} from "./harness.js";

let fetchDouble: FetchDouble | undefined;

afterEach(() => {
  fetchDouble?.restore();
  fetchDouble = undefined;
  vi.useRealTimers();
});

/** Claim one question and assemble once — the loop's order, in miniature. */
async function turn(
  fake: ReturnType<typeof createFakeContext>,
  agentId: string,
  question: string,
  signal?: AbortSignal
) {
  claim(fake, agentId, question);
  return assemble(fake, agentId, signal);
}

describe("recall", () => {
  it("registers the claim listener and the assemble waterfall, and no prompt section", () => {
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    expect(fake.listeners.has("agent/inbox/claimed")).toBe(true);
    expect(fake.listeners.has("system-prompt/assemble")).toBe(true);
    // Recall must not be a registered context provider: `assemble()` evaluates
    // those eagerly, BEFORE the waterfall, which is what made the previous
    // design one assembly late.
    expect(fake.listeners.has("agent/pre-step")).toBe(false);
  });

  it("happy path: the SodaMem text is contributed to the assembly for that agent", async () => {
    fetchDouble = installContextFetch("remembered");
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    const { text, assembly, nextCalled } = await turn(fake, "agent-a", "where do I live?");

    expect(text).toBe("remembered");
    expect(assembly.contexts).toEqual([{ name: "sodamem", text: "remembered" }]);
    expect(nextCalled).toBe(true);

    const url = new URL(fetchDouble.calls[0]!.url);
    expect(url.pathname).toBe("/v1/context");
    expect(url.searchParams.get("query")).toBe("where do I live?");
    expect(url.searchParams.get("user_id")).toBe(CONFIG.userId);
    expect(url.searchParams.get("token_budget")).toBe("1200");
  });

  it("recalls for the question claimed on THIS assembly, not the previous one", async () => {
    let answer = "pets";
    fetchDouble = installFetch(() => ({
      ok: true,
      status: 200,
      statusText: "",
      text: async () => JSON.stringify({ text: answer }),
    }));
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    expect((await turn(fake, "agent-a", "do I have a pet?")).text).toBe("pets");
    answer = "flights";
    expect((await turn(fake, "agent-a", "which airline?")).text).toBe("flights");
  });

  it("always calls next(), so a SodaMem failure can never break prompt assembly", async () => {
    fetchDouble = installUnreachableFetch();
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    const { text, nextCalled, assembly } = await turn(fake, "agent-a", "hello");

    expect(nextCalled).toBe(true);
    expect(text).toBe("");
    expect(assembly.contexts).toEqual([]);
    expect(fake.logs.some((entry) => entry.level === "warn")).toBe(true);
  });

  it("contributes nothing and issues no request when the batch has no text", async () => {
    fetchDouble = installContextFetch("remembered");
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    claim(fake, "agent-a", "");
    const { text, nextCalled } = await assemble(fake, "agent-a");

    expect(text).toBe("");
    expect(nextCalled).toBe(true);
    expect(fetchDouble.calls).toHaveLength(0);
  });

  it("contributes nothing on a diagnostics assembly, which carries no agent", async () => {
    fetchDouble = installContextFetch("remembered");
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    const { text, nextCalled } = await assemble(fake, undefined);

    expect(text).toBe("");
    expect(nextCalled).toBe(true);
    expect(fetchDouble.calls).toHaveLength(0);
  });

  it("fires once per claimed batch, not once per assembly", async () => {
    fetchDouble = installContextFetch("remembered");
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    claim(fake, "agent-a", "one question");
    // Every step of a tool loop assembles a prompt; only the first may fetch.
    expect((await assemble(fake, "agent-a")).text).toBe("remembered");
    expect((await assemble(fake, "agent-a")).text).toBe("remembered");
    expect((await assemble(fake, "agent-a")).text).toBe("remembered");

    expect(fetchDouble.calls).toHaveLength(1);
  });

  it("joins every message of one claimed batch into a single query", async () => {
    fetchDouble = installContextFetch("remembered");
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    claim(fake, "agent-a", "first", "second");
    await assemble(fake, "agent-a");

    expect(fetchDouble.calls).toHaveLength(1);
    expect(new URL(fetchDouble.calls[0]!.url).searchParams.get("query")).toBe("first\nsecond");
  });

  it("unreachable SodaMem: the assembly proceeds and contributes ''", async () => {
    fetchDouble = installUnreachableFetch();
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    expect((await turn(fake, "agent-a", "hello")).text).toBe("");
  });

  it("request timeout: the 1500ms deadline ends the wait, not the harness", async () => {
    vi.useFakeTimers();
    fetchDouble = installHangingFetch();
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    claim(fake, "agent-a", "hello");
    const pending = assemble(fake, "agent-a");
    await vi.advanceTimersByTimeAsync(1500);

    expect((await pending).text).toBe("");
  });

  it("stalled response BODY: the 1500ms deadline still ends the wait", async () => {
    vi.useFakeTimers();
    fetchDouble = installStallingBodyFetch();
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    claim(fake, "agent-a", "hello");
    const pending = assemble(fake, "agent-a");
    await vi.advanceTimersByTimeAsync(1500);

    expect((await pending).text).toBe("");
  });

  it("stalled body on a transport that ignores the signal: the deadline still ends the wait", async () => {
    vi.useFakeTimers();
    fetchDouble = installUncancellableBodyFetch();
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    claim(fake, "agent-a", "hello");
    const pending = assemble(fake, "agent-a");
    await vi.advanceTimersByTimeAsync(1500);

    expect((await pending).text).toBe("");
  });

  it("passes the assembly's signal through, so recall aborts when the turn does", async () => {
    fetchDouble = installContextFetch("remembered");
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    const controller = new AbortController();
    await turn(fake, "agent-a", "hello", controller.signal);

    const signal = fetchDouble.calls[0]!.signal;
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    controller.abort();
    expect(signal!.aborted).toBe(true);
  });

  it("caps the query so a pasted file cannot produce a 414-length URL", async () => {
    fetchDouble = installContextFetch("remembered");
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    await turn(fake, "agent-a", "x".repeat(MAX_QUERY_CHARS * 3));

    const query = new URL(fetchDouble.calls[0]!.url).searchParams.get("query") ?? "";
    expect(query.length).toBe(MAX_QUERY_CHARS);
  });

  it("capQuery keeps the tail when the text overflows the cap", () => {
    const query = capQuery("A".repeat(MAX_QUERY_CHARS) + "TAIL");
    expect(query.length).toBe(MAX_QUERY_CHARS);
    expect(query.endsWith("TAIL")).toBe(true);
  });

  it("cache isolation: two agent ids get their own text and neither reads the other's", async () => {
    const answers: Record<string, string> = { "agent-a": "alpha", "agent-b": "beta" };
    fetchDouble = installFetch((call) => {
      const query = new URL(call.url).searchParams.get("query") ?? "";
      return {
        ok: true,
        status: 200,
        statusText: "",
        text: async () => JSON.stringify({ text: answers[query] ?? "" }),
      };
    });
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    await turn(fake, "agent-a", "agent-a");
    await turn(fake, "agent-b", "agent-b");

    expect(await contributedText(fake, "agent-a")).toBe("alpha");
    expect(await contributedText(fake, "agent-b")).toBe("beta");
    expect(await contributedText(fake, "agent-c")).toBe("");
  });

  it("sanitises {{ so strict interpolation cannot fail the assembly", async () => {
    fetchDouble = installContextFetch("remembered {{secret}} value");
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    const { text } = await turn(fake, "agent-a", "hello");
    expect(text).not.toContain("{{");
  });

  it("sanitizeContextText leaves no {{ token behind", () => {
    expect(sanitizeContextText("{{a}}")).not.toContain("{{");
    expect(sanitizeContextText("{{{{a}}}}")).not.toContain("{{");
    expect(sanitizeContextText("plain")).toBe("plain");
  });

  it("a claim listener failure cannot escape into the loop's claim path", () => {
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    const listener = fake.listeners.get("agent/inbox/claimed") as unknown as (p: unknown) => void;
    expect(() => listener(undefined)).not.toThrow();
    expect(() => listener({ agent: { id: "a" }, message: { content: undefined } })).not.toThrow();
  });
});
