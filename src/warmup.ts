/**
 * Warm the SodaMem path when the plugin loads, so the user's first question is
 * not the one that pays for it.
 *
 * The daemon opens a user's store LAZILY, on the first request that touches it
 * — connecting to Chroma, loading the BM25 index. Measured on a real 1000-fact
 * store across 3 daemon restarts, that first request costs about 5x steady
 * state:
 *
 * ```
 * round 1: cold 880ms status=200  then 152/134/127/125/182ms
 * round 2: cold 633ms status=200  then 136/129/136/126/136ms
 * round 3: cold 619ms status=200  then 135/128/130/129/138ms
 * ```
 *
 * It SUCCEEDS — 200 in 3 restarts out of 3, full vector routes — and the
 * second request is already at steady state. So this is a one-time store-open
 * cost, and the only question is who pays it: the plugin at load, or the user
 * on their first question.
 *
 * RETRACTION. This comment previously justified the warm-up by claiming the
 * first request "failed outright every single time" with a
 * `pyo3_runtime.PanicException` out of Chroma's Rust bindings. That was an
 * artifact of the measurement machine — a store schema-migrated by one
 * chromadb version and then read by an older one — not a daemon defect, and it
 * is withdrawn. See NOTES-latency.md. The latency justification survived
 * re-measurement; the failure justification did not.
 *
 * Contract, all three load-bearing:
 * - it never blocks `apply()` — the work is started, never awaited;
 * - it never throws and never rejects, including when no daemon is running at
 *   startup, which is an ordinary way to boot;
 * - it stops when the plugin unloads.
 */
import { withSodaMem } from "./client.js";
import type { SodaMemConfig } from "./config.js";
import type { PluginLogger } from "./recall.js";

/**
 * Generous, because this is off the critical path entirely — nothing waits on
 * it. It exists only so a hung daemon cannot leave the request pending for
 * undici's 300s body timeout after the plugin has already unloaded.
 */
export const WARMUP_TIMEOUT_MS = 10_000;

/**
 * One request is enough to open the store — measurement shows the request
 * after the cold one is already at steady state. The second attempt is an
 * ordinary retry, taken ONLY if the first fails: a daemon still binding its
 * port, or a transient error. On the happy path exactly one request is sent.
 */
export const WARMUP_ATTEMPTS = 2;

/** The daemon's minimum accepted `token_budget` — the cheapest legal request. */
export const WARMUP_TOKEN_BUDGET = 100;

/**
 * A neutral query. The content does not matter — the point is to make the
 * daemon open the store and touch the index — but it is a constant so tests
 * can tell a warm-up apart from a real recall.
 */
export const WARMUP_QUERY = "sodamem plugin warmup";

export interface WarmupDeps {
  readonly config: SodaMemConfig;
  readonly logger: PluginLogger;
  /** Aborted when the plugin unloads. */
  readonly signal: AbortSignal;
}

/**
 * Start warming the path. Returns immediately.
 */
export function startWarmup(deps: WarmupDeps): void {
  const { config, logger, signal } = deps;

  void (async () => {
    for (let attempt = 1; attempt <= WARMUP_ATTEMPTS; attempt++) {
      if (signal.aborted) return;
      try {
        await withSodaMem(config, WARMUP_TIMEOUT_MS, signal, (client) =>
          client.context({
            user_id: config.userId,
            query: WARMUP_QUERY,
            token_budget: WARMUP_TOKEN_BUDGET,
          })
        );
        logger.debug("sodamem warm-up succeeded on attempt %d; recall is hot", attempt);
        return;
      } catch (error) {
        // Entirely expected when no daemon is running yet — booting before the
        // daemon is an ordinary way to start.
        logger.debug("sodamem warm-up attempt %d did not succeed: %o", attempt, error);
      }
    }
  })();
}
