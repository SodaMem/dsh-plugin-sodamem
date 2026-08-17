/**
 * dsh-plugin-sodamem — SodaMem as a memory layer for the DeepSeek Harness.
 *
 * Recall is unconditional: every turn is assembled with whatever SodaMem
 * knows, through `agent/inbox/claimed` + the `system-prompt/assemble`
 * waterfall.
 * Retain is unconditional: every closed turn is ingested, through
 * `agent/turn-stopping`.
 *
 * Neither is a tool, so neither is left to the model's discretion — which is
 * the whole reason this exists rather than another MCP server.
 *
 * Remote only. The plugin speaks HTTP to a running SodaMem daemon and imports
 * nothing that can open a store: two local writers on one `SODAMEM_DATA_ROOT`
 * corrupt it, and a plugin inside an arbitrary harness process is the worst
 * possible second writer.
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import { RecallCache } from "./cache.js";
import { Config, type SodaMemConfig } from "./config.js";
import { createAssembleListener, createClaimListener, type PluginLogger } from "./recall.js";
import { RetainLedger, createRetainListener } from "./retain.js";
import { startWarmup } from "./warmup.js";

export { Config, type SodaMemConfig } from "./config.js";
export {
  RECALL_TIMEOUT_MS,
  RETAIN_TIMEOUT_MS,
  MAX_QUERY_CHARS,
  CONTEXT_NAME,
} from "./config.js";
export { RecallCache, type RecallEntry, type RecallTicket } from "./cache.js";
export { capQuery, createAssembleListener, createClaimListener } from "./recall.js";
export { RetainLedger, collectTurnMessages, createRetainListener } from "./retain.js";
export {
  WARMUP_ATTEMPTS,
  WARMUP_QUERY,
  WARMUP_TIMEOUT_MS,
  WARMUP_TOKEN_BUDGET,
  startWarmup,
} from "./warmup.js";
export { renderTextBlocks, sanitizeContextText } from "./messages.js";
export { createClient, withSodaMem, SodaMemDeadlineError } from "./client.js";

export const name = "sodamem";

export const inject = ["systemPrompt"];

export function apply(ctx: Context, config: SodaMemConfig): void {
  const cache = new RecallCache();
  const ledger = new RetainLedger();
  const logger = ctx.logger as unknown as PluginLogger;

  // Aborted on unload, so a warm-up in flight cannot outlive the plugin.
  const unloading = new AbortController();

  const disposers: Array<() => unknown> = [
    ctx.on("agent/inbox/claimed", createClaimListener({ cache, logger })),
    ctx.on("system-prompt/assemble", createAssembleListener({ config, cache, logger })),
    ctx.on("agent/turn-stopping", createRetainListener({ config, logger, ledger })),
    ctx.on("agent/disposed", (payload) => {
      // The only listener the harness gives no failure isolation of its own.
      try {
        const agentId = payload?.agent?.id;
        if (!agentId) return;
        cache.delete(agentId);
        ledger.delete(agentId);
      } catch (error) {
        logger.warn("sodamem could not evict the disposed agent: %o", error);
      }
    }),
  ];

  // Started, never awaited: the daemon opens a store lazily, and the first
  // request to touch it is slow and currently fails outright. Paying that here
  // means the user's first question does not.
  startWarmup({ config, logger, signal: unloading.signal });

  // Every registration is released on unload, in reverse order, and the state
  // goes with them — nothing survives the fiber.
  ctx.effect(() => () => {
    unloading.abort();
    for (const dispose of disposers.splice(0).reverse()) dispose();
    cache.clear();
    ledger.clear();
  }, "dsh-plugin-sodamem");
}
