/**
 * Cold start, on purpose.
 *
 * The rest of the suite warms the daemon in `beforeAll` so its assertions are
 * deterministic. This file does the opposite: it restarts the daemon and then
 * asserts what a stranger actually experiences on their very first question.
 *
 * It needs to be able to restart the daemon, so it is opt-in. Point it at a
 * SodaMem checkout and it runs; otherwise it skips loudly rather than pretending
 * to have proven something:
 *
 *     SODAMEM_TEST_DAEMON_CWD=/path/to/SodaMem npm run test:integration
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DAEMON_KEY, DAEMON_URL, DAEMON_USER, bootRuntime } from "./runtime.js";

const DAEMON_CWD = process.env.SODAMEM_TEST_DAEMON_CWD;
const DATA_ROOT = process.env.SODAMEM_TEST_DATA_ROOT;
const enabled = Boolean(DAEMON_CWD && DATA_ROOT);

function sodamem(...args: string[]): string {
  return execFileSync(`${DAEMON_CWD}/.venv/bin/sodamem`, args, {
    cwd: DAEMON_CWD,
    env: { ...process.env, PATH: `${DAEMON_CWD}/.venv/bin:${process.env.PATH ?? ""}` },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function restartDaemon(): void {
  try {
    sodamem("daemon", "stop");
  } catch {
    /* not running */
  }
  execFileSync("/bin/sleep", ["1"]);
  sodamem(
    "daemon",
    "ensure",
    "--api-url",
    DAEMON_URL,
    "--api-key",
    DAEMON_KEY,
    "--data-root",
    DATA_ROOT!
  );
}

describe.skipIf(!enabled)("cold start", () => {
  it("the first question after a daemon restart still gets memory", async () => {
    restartDaemon();

    // A stranger's sequence exactly: the daemon is cold, the plugin loads, and
    // then they ask. Without the load-time warm-up the first request is the one
    // that opens the store — which is slow and currently panics — so this turn
    // silently got no memory at all.
    const runtime = await bootRuntime({
      apiUrl: DAEMON_URL,
      apiKey: DAEMON_KEY,
      userId: DAEMON_USER,
      tokenBudget: 1200,
    });
    try {
      await runtime.ask("do I have a pet?");
      const evidence = runtime.adapter.topEvidence(0);
      // eslint-disable-next-line no-console
      console.log(`[cold start] first-turn evidence: ${evidence.slice(0, 120) || "(none)"}`);
      expect(evidence).toContain("golden retriever");
    } finally {
      await runtime.dispose();
    }
  }, 120_000);
});

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log(
    "[cold start] SKIPPED — set SODAMEM_TEST_DAEMON_CWD and SODAMEM_TEST_DATA_ROOT to run it"
  );
}
