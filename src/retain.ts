/**
 * Retain: ingest every closed turn, without the model having to decide to
 * write.
 *
 * `agent/turn-stopping` fires before `turn/end` reaches the log, so the turn
 * is sliced out of `session.events` by hand: find this turn's `turn/start`,
 * project every event at or after it with `deriveEventMessage`, keep the
 * user- and assistant-role prose.
 */
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Message } from "sodamem";
import { withSodaMem } from "./client.js";
import { RETAIN_TIMEOUT_MS, type SodaMemConfig } from "./config.js";
import { renderTextBlocks } from "./messages.js";
import type { PluginLogger } from "./recall.js";

/** The shape of a session event this module reads. */
export interface RetainEvent {
  readonly type: string;
  readonly data: unknown;
}

/** The projection `deriveEventMessage` returns, as far as retain cares. */
export interface DerivedMessage {
  readonly role?: string;
  readonly content?: readonly ContentBlock[];
  readonly source?: { readonly kind?: string };
}

/**
 * Whether a projected message is prose somebody actually produced.
 *
 * `role` alone is not enough. The harness carries several things as
 * `role: 'user'` that nobody said: tool results (`kind: 'tool'`) are machine
 * chatter that would drown the extractor, and plugin-authored context
 * (`kind: 'plugin'`) includes the runtime-context snapshot — which is where
 * THIS plugin's own recalled evidence lives.
 *
 * Ingesting that snapshot would feed SodaMem its own output back on every
 * turn: each recall would be re-extracted as fresh facts, which the next
 * recall would return, and the store would amplify its own echo. Only the
 * human's `kind: 'user'` prose and the model's `kind: 'model'` replies are
 * worth remembering.
 */
function isAuthoredProse(derived: DerivedMessage): boolean {
  const kind = derived.source?.kind;
  if (derived.role === "user") return kind === "user";
  if (derived.role === "assistant") return kind === "model";
  return false;
}

/** The subset of `Session` retain reads. */
export interface RetainSession {
  readonly events: readonly RetainEvent[];
  deriveEventMessage(event: RetainEvent): DerivedMessage | null;
}

/** The subset of the `agent/turn-stopping` payload retain reads. */
export interface RetainPayload {
  readonly agent: { readonly id: string; readonly session: RetainSession };
  readonly turn: number;
  readonly signal?: AbortSignal;
}

export interface RetainDeps {
  readonly config: SodaMemConfig;
  readonly logger: PluginLogger;
  readonly ledger: RetainLedger;
}

/**
 * How much of each turn has already been ingested.
 *
 * `agent/turn-stopping` is not once-per-turn: the loop re-enters when a
 * listener queues next-step work, and `collectTurnMessages` always slices from
 * `turn/start`, so a second firing would re-send everything the first one
 * already sent. Duplicate writes into a user's store are the worst kind of
 * bug here — they are silent, they compound, and extraction turns each copy
 * into more facts.
 *
 * Recording a COUNT rather than a "done" flag keeps the other half honest
 * too: when a re-entered turn really did produce more prose, the tail still
 * gets ingested, exactly once.
 */
export class RetainLedger {
  private readonly sent = new Map<string, { turn: number; count: number }>();

  /** How many of this turn's messages have already gone to SodaMem. */
  sentCount(agentId: string, turn: number): number {
    const entry = this.sent.get(agentId);
    return entry !== undefined && entry.turn === turn ? entry.count : 0;
  }

  record(agentId: string, turn: number, count: number): void {
    this.sent.set(agentId, { turn, count });
  }

  delete(agentId: string): void {
    this.sent.delete(agentId);
  }

  clear(): void {
    this.sent.clear();
  }

  get size(): number {
    return this.sent.size;
  }
}

function isTurnStart(event: RetainEvent, turn: number): boolean {
  if (event.type !== "turn/start") return false;
  const data = event.data as { turn?: unknown } | null;
  return !!data && data.turn === turn;
}

/**
 * The closed turn's authored prose — what the human said and what the model
 * replied — in log order, rendered to flat text. Empty when the turn produced
 * nothing worth remembering, in which case nothing is ingested.
 */
export function collectTurnMessages(session: RetainSession, turn: number): Message[] {
  const events = session?.events;
  if (!events || events.length === 0) return [];

  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event && isTurnStart(event, turn)) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];

  const messages: Message[] = [];
  for (let i = start; i < events.length; i++) {
    const event = events[i];
    if (!event) continue;
    const derived = session.deriveEventMessage(event);
    if (!derived) continue;
    if (!isAuthoredProse(derived)) continue;
    const content = renderTextBlocks(derived.content);
    if (!content) continue;
    messages.push({ role: derived.role as Message["role"], content });
  }
  return messages;
}

/**
 * The `agent/turn-stopping` listener. It is awaited by the machine, so it
 * swallows everything: a throw here would surface in the user's turn.
 *
 * The write uses the default `async_mode` (202 + `job_id`), so the harness
 * never waits on fact extraction. The job is deliberately not polled.
 */
export function createRetainListener(deps: RetainDeps) {
  const { config, logger, ledger } = deps;

  return async function onTurnStopping(payload: RetainPayload): Promise<void> {
    try {
      const agent = payload?.agent;
      if (!agent?.session) return;
      const collected = collectTurnMessages(agent.session, payload.turn);

      // Send only what a previous firing for this same turn did not.
      const alreadySent = ledger.sentCount(agent.id, payload.turn);
      const messages = collected.slice(alreadySent);
      if (messages.length === 0) return;

      // Recorded BEFORE the request: a retried or concurrent firing must not
      // be able to send this slice twice, and a failed write is not worth
      // re-sending blind — the turn is already over.
      ledger.record(agent.id, payload.turn, collected.length);

      await withSodaMem(config, RETAIN_TIMEOUT_MS, payload.signal, (client) =>
        client.add({
          user_id: config.userId,
          session_id: agent.id,
          messages,
        })
      );
    } catch (error) {
      logger.warn("sodamem retain failed; the closed turn was not ingested: %o", error);
    }
  };
}
