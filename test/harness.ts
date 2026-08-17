/**
 * Test doubles. Everything is mocked at the HTTP boundary (`globalThis.fetch`)
 * and at the Cordis registration boundary — no live daemon, ever, and no dsh
 * runtime either.
 *
 * These doubles prove the units. They cannot prove the plugin works inside the
 * real loop — that is what `test-integration/` is for, and the ordering bug it
 * caught is exactly the class of failure a double like this cannot see.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import type { SodaMemConfig } from "../src/config.js";
import { WARMUP_QUERY } from "../src/warmup.js";

export const CONFIG: SodaMemConfig = {
  apiUrl: "http://127.0.0.1:8000",
  apiKey: "test-key",
  userId: "aaron",
  tokenBudget: 1200,
};

// --- fetch double ------------------------------------------------------------

export interface RecordedCall {
  url: string;
  method: string | undefined;
  body: string | undefined;
  signal: AbortSignal | undefined;
}

export interface FetchDouble {
  /** Every recorded call, warm-up included. */
  calls: RecordedCall[];
  /**
   * Calls that are not the plugin's load-time warm-up.
   *
   * `apply()` fires a warm-up request so the user's first question is not the
   * one that pays for the daemon's lazy store open. It is fire-and-forget, so
   * assertions about recall traffic must exclude it rather than race it.
   */
  readonly recallCalls: RecordedCall[];
  restore(): void;
}

type FetchInit = { method?: string; body?: string; signal?: AbortSignal } | undefined;
type FetchResponse = { ok: boolean; status: number; statusText: string; text(): Promise<string> };

function jsonResponse(status: number, body: unknown): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  };
}

/** Install a `globalThis.fetch` driven by `handler`, recording every call. */
export function installFetch(
  handler: (call: RecordedCall) => Promise<FetchResponse> | FetchResponse
): FetchDouble {
  const original = (globalThis as { fetch?: unknown }).fetch;
  const calls: RecordedCall[] = [];

  const impl = (url: string, init: FetchInit) => {
    const call: RecordedCall = {
      url,
      method: init?.method,
      body: init?.body,
      signal: init?.signal,
    };
    calls.push(call);
    return Promise.resolve(handler(call));
  };

  (globalThis as { fetch?: unknown }).fetch = impl;
  return {
    calls,
    get recallCalls() {
      return calls.filter(
        (call) => new URL(call.url, "http://x").searchParams.get("query") !== WARMUP_QUERY
      );
    },
    restore() {
      (globalThis as { fetch?: unknown }).fetch = original;
    },
  };
}

/** A fetch that always answers `GET /v1/context` with `text`. */
export function installContextFetch(text: string): FetchDouble {
  return installFetch(() => jsonResponse(200, { text, citations: [], evidence: [], degraded: [] }));
}

/** A fetch that answers `POST /v1/memories` with the async-mode 202. */
export function installAcceptedFetch(): FetchDouble {
  return installFetch(() =>
    jsonResponse(202, { job_id: "job-1", status: "pending", session_id: "s" })
  );
}

/** A fetch that rejects the way an unreachable daemon does. */
export function installUnreachableFetch(): FetchDouble {
  return installFetch(() =>
    Promise.reject(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8000"), { name: "TypeError" })
    )
  );
}

/**
 * A fetch whose HEADERS arrive normally and whose BODY then stalls forever.
 *
 * This is the shape the SDK cannot bound on its own: it clears its deadline
 * the moment headers land, so `response.text()` is awaited with no timer. Like
 * undici, the body read here rejects when the request signal aborts.
 */
export function installStallingBodyFetch(): FetchDouble {
  return installFetch((call) => ({
    ok: true,
    status: 200,
    statusText: "",
    text: () =>
      new Promise<string>((_resolve, reject) => {
        call.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        });
      }),
  }));
}

/**
 * A fetch whose body stalls forever and IGNORES the abort signal entirely —
 * a transport that does not propagate cancellation into the body stream. The
 * plugin's deadline must still end the wait.
 */
export function installUncancellableBodyFetch(): FetchDouble {
  return installFetch(() => ({
    ok: true,
    status: 200,
    statusText: "",
    text: () => new Promise<string>(() => {}),
  }));
}

/** A fetch that never settles until its request is aborted (headers phase). */
export function installHangingFetch(): FetchDouble {
  return installFetch(
    (call) =>
      new Promise<FetchResponse>((_resolve, reject) => {
        call.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        });
      })
  );
}

// --- cordis context double ---------------------------------------------------

export interface FakeContext {
  ctx: Context;
  listeners: Map<string, (...args: never[]) => unknown>;
  /** Registration labels whose disposer has been called, in call order. */
  disposedLabels: string[];
  /** Run the disposer `apply()` handed to `ctx.effect()`. */
  unload(): void;
  logs: { level: string; args: unknown[] }[];
}

export function createFakeContext(): FakeContext {
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const disposedLabels: string[] = [];
  const logs: { level: string; args: unknown[] }[] = [];
  let effectDisposer: (() => unknown) | undefined;

  const state: FakeContext = {
    ctx: undefined as unknown as Context,
    listeners,
    disposedLabels,
    logs,
    unload() {
      effectDisposer?.();
    },
  };

  const log = (level: string) => (...args: unknown[]) => {
    logs.push({ level, args });
  };

  const logger = Object.assign(() => logger, {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  });

  const ctx = {
    logger,
    on(event: string, listener: (...args: never[]) => unknown) {
      listeners.set(event, listener);
      return () => {
        disposedLabels.push(event);
        return true;
      };
    },
    effect(body: () => () => unknown) {
      effectDisposer = body();
      return () => {};
    },
  };

  state.ctx = ctx as unknown as Context;
  return state;
}

// --- driving the plugin's two recall listeners ------------------------------

/** A fresh, empty prompt assembly, as `SystemPrompt.assemble()` builds one. */
export function emptyAssembly(): PromptAssembly {
  return { sections: [], contexts: [], tools: [], variables: {} };
}

/** Deliver one `agent/inbox/claimed` event, the way the loop does while claiming. */
export function claim(fake: FakeContext, agentId: string, ...texts: string[]): void {
  for (const text of texts) {
    claimFrom(fake, agentId, { kind: "user" }, text);
  }
}

/** Deliver a claimed message from an arbitrary source (injection, steering, a plugin). */
export function claimFrom(
  fake: FakeContext,
  agentId: string,
  source: { kind: string } | undefined,
  text: string
): void {
  const listener = fake.listeners.get("agent/inbox/claimed") as unknown as (p: unknown) => void;
  if (!listener) throw new Error("no agent/inbox/claimed listener registered");
  listener({ agent: { id: agentId }, message: { content: textBlocks(text), source } });
}

/**
 * Run the `system-prompt/assemble` waterfall once and return the assembly the
 * loop would use, plus whatever SodaMem contributed to it.
 */
export async function assemble(
  fake: FakeContext,
  agentId: string | undefined,
  signal?: AbortSignal
): Promise<{ assembly: PromptAssembly; text: string; nextCalled: boolean }> {
  const listener = fake.listeners.get("system-prompt/assemble") as unknown as (
    assembly: PromptAssembly,
    context: unknown,
    next: () => Promise<PromptAssembly>
  ) => Promise<PromptAssembly>;
  if (!listener) throw new Error("no system-prompt/assemble listener registered");

  const assembly = emptyAssembly();
  const context: Record<string, unknown> = {};
  if (agentId !== undefined) context.agent = { id: agentId };
  if (signal !== undefined) context.signal = signal;

  let nextCalled = false;
  const result = await listener(assembly, context, async () => {
    nextCalled = true;
    return assembly;
  });
  const contributed = result.contexts.find((entry) => entry.name === "sodamem");
  return { assembly: result, text: contributed?.text ?? "", nextCalled };
}

/** The SodaMem text contributed to one assembly for one agent. */
export async function contributedText(
  fake: FakeContext,
  agentId: string | undefined
): Promise<string> {
  return (await assemble(fake, agentId)).text;
}

// --- payload builders --------------------------------------------------------

export function textBlocks(...texts: string[]): ContentBlock[] {
  return texts.map((text) => ({ type: "text", text }) as ContentBlock);
}

/** Prose the human actually typed. */
export function userMessage(text: string) {
  return { role: "user" as const, content: textBlocks(text), source: { kind: "user" as const } };
}

/** Prose the model produced. */
export function assistantMessage(text: string) {
  return { role: "assistant" as const, content: textBlocks(text), source: { kind: "model" as const } };
}

/** A tool result — `role: 'user'`, but nobody said it. */
export function toolResultMessage(text: string) {
  return { role: "user" as const, content: textBlocks(text), source: { kind: "tool" as const } };
}

/**
 * The harness's runtime-context snapshot — `role: 'user'`, authored by a
 * plugin, and the carrier of THIS plugin's own recalled evidence.
 */
export function snapshotMessage(text: string) {
  return {
    role: "user" as const,
    content: textBlocks(text),
    source: { kind: "plugin" as const, plugin: "@deepseek-ai/dsh-system-prompt", form: "snapshot" },
  };
}

export interface FakeEvent {
  type: string;
  data: unknown;
  message?: { role: string; content: ContentBlock[]; source?: { kind?: string } };
}

/** A session double whose `deriveEventMessage` projects the event's message. */
export function fakeSession(events: FakeEvent[]) {
  return {
    events,
    deriveEventMessage(event: { type: string; data: unknown }) {
      return (event as FakeEvent).message ?? null;
    },
  };
}
