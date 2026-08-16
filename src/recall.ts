/**
 * Recall: contribute what SodaMem knows to every turn, without the model
 * having to ask.
 *
 * Recall lives on `system-prompt/assemble`, because that is the only hook that
 * is both asynchronous and early enough. The loop assembles the prompt and
 * projects its runtime-context snapshot BEFORE it dispatches `agent/pre-step`:
 *
 * ```js
 * const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
 * const context  = this.runtimeContext.project(joinContextSections(...));
 * const decision = await this.dispatch.waterfall('agent/pre-step', { ... });
 * return { ...decision, assembly };
 * ```
 *
 * An earlier version of this plugin fetched in `agent/pre-step` and served the
 * result from a synchronous `systemPrompt.context` provider. That is one
 * assembly too late by construction: turn N's evidence first became visible to
 * the assembly at the END of turn N and reached the model in turn N+1's
 * request, so every answer was to the previous question. `assemble()` also
 * evaluates registered context providers eagerly, before the waterfall runs,
 * so warming a cache from the waterfall could not have fixed it either — the
 * contribution has to be pushed into the assembly itself.
 *
 * The question comes from `agent/inbox/claimed`, which fires — with the turn
 * and the message — while the loop claims the batch, immediately before it
 * assembles. That is the same batch `agent/pre-step` used to receive.
 */
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { AssembleContext, PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import type { RecallCache } from "./cache.js";
import { withSodaMem } from "./client.js";
import { CONTEXT_NAME, MAX_QUERY_CHARS, RECALL_TIMEOUT_MS, type SodaMemConfig } from "./config.js";
import { renderTextBlocks, sanitizeContextText } from "./messages.js";

/** The subset of `ctx.logger` this plugin uses. */
export interface PluginLogger {
  debug(format: unknown, ...args: unknown[]): void;
  warn(format: unknown, ...args: unknown[]): void;
}

/** The subset of the `agent/inbox/claimed` payload recall reads. */
export interface ClaimPayload {
  readonly agent: { readonly id: string };
  readonly message: { readonly content?: readonly ContentBlock[] };
}

export interface RecallDeps {
  readonly config: SodaMemConfig;
  readonly cache: RecallCache;
  readonly logger: PluginLogger;
}

/**
 * Bound the recall query.
 *
 * The query travels as a `GET` query parameter, so an uncapped one (a pasted
 * file, a long stack trace) becomes a multi-kilobyte URL and earns a 414 or
 * 431 — killing recall on exactly the content-heavy turns where memory is most
 * useful. When the text overflows, the TAIL is kept: the most recent text is
 * the closest thing to what the user just asked.
 */
export function capQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length <= MAX_QUERY_CHARS) return trimmed;
  return trimmed.slice(trimmed.length - MAX_QUERY_CHARS).trim();
}

/**
 * The `agent/inbox/claimed` listener: remember what was just asked.
 *
 * It does no I/O and never throws — a failure here would surface inside the
 * loop's claim path.
 */
export function createClaimListener(deps: Pick<RecallDeps, "cache" | "logger">) {
  const { cache, logger } = deps;

  return function onClaimed(payload: ClaimPayload): void {
    try {
      const agentId = payload?.agent?.id;
      if (!agentId) return;
      cache.claim(agentId, renderTextBlocks(payload.message?.content));
    } catch (error) {
      logger.warn("sodamem could not read the claimed message; no memory this turn: %o", error);
    }
  };
}

/**
 * The `system-prompt/assemble` listener.
 *
 * Contract, in order of importance:
 * - it ALWAYS `return next()`. Assembly failing is strictly worse than recall
 *   failing: it kills the turn outright rather than costing it its memory;
 * - it never throws and never rejects — every SodaMem failure degrades to
 *   "no memory this turn";
 * - it issues at most one request per claimed batch, so the steps of a tool
 *   loop reuse one answer instead of re-asking the daemon on every step.
 */
export function createAssembleListener(deps: RecallDeps) {
  const { config, cache, logger } = deps;

  async function warm(agentId: string, signal: AbortSignal | undefined): Promise<void> {
    const query = cache.take(agentId);
    if (query === undefined) return;
    const response = await withSodaMem(config, RECALL_TIMEOUT_MS, signal, (client) =>
      client.context({
        user_id: config.userId,
        query: capQuery(query),
        token_budget: config.tokenBudget,
      })
    );
    const text = typeof response?.text === "string" ? response.text : "";
    cache.resolve(agentId, sanitizeContextText(text));
  }

  return async function onAssemble(
    assembly: PromptAssembly,
    context: AssembleContext,
    next: () => Promise<PromptAssembly>
  ): Promise<PromptAssembly> {
    // `context.agent` is absent on diagnostics assemblies; contributing
    // nothing is exactly the right answer there.
    const agentId = context?.agent?.id;

    if (agentId) {
      try {
        await warm(agentId, context.signal);
      } catch (error) {
        logger.warn("sodamem recall failed; continuing with no memory this turn: %o", error);
      }
    }

    try {
      const text = cache.get(agentId);
      if (text) assembly.contexts.push({ name: CONTEXT_NAME, text });
    } catch (error) {
      logger.warn("sodamem could not contribute its memory to this assembly: %o", error);
    }

    return next();
  };
}

export { CONTEXT_NAME };
