/**
 * Warm the SodaMem path when the plugin loads, so the user's first question is
 * not the one that pays for it.
 *
 * The daemon opens a user's store LAZILY, on the first request that touches it
 * — connecting to Chroma, loading the BM25 index. Measured on a real 1000-fact
 * store across 8 daemon restarts, that first request cost 426–773 ms and
 * failed outright every single time:
 *
 * ```
 * File "server/stores.py", line 123, in get
 *   mem = SodaMem.open(path, extractor=self._build_extractor())
 * File "chromadb/api/rust.py", line 114, in start
 *   self.bindings = chromadb_rust_bindings.Bindings(
 * pyo3_runtime.PanicException: range start index 10 out of range for slice of length 9
 * ```
 *
 * The SECOND request succeeds (140–242 ms), and every one after that is
 * 14–48 ms. So without this, a stranger installs the plugin, asks their first
 * question, and silently gets no memory — the designed degrade working
 * perfectly on a cost nobody warned them about.
 *
 * This is a daemon-side defect and it should be fixed there too; absorbing it
 * here is not a substitute for that. But the plugin is the side that knows
 * when it is about to be used, so it is the side that can pay the cost early.
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
 * Two attempts, because one is not enough: the first request is the one that
 * triggers the lazy store open, and that is the one that panics. The second
 * both confirms the path is live and leaves it hot.
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
        // Entirely expected when no daemon is running yet, and expected on
        // attempt 1 against a daemon that has not opened this store before.
        logger.debug("sodamem warm-up attempt %d did not succeed: %o", attempt, error);
      }
    }
  })();
}
