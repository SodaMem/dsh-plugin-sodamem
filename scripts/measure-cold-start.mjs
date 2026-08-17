#!/usr/bin/env node
/**
 * Measure the COLD `/v1/context` cost: the first request after a daemon start.
 *
 * The daemon opens a user's store lazily, so the first request that touches it
 * pays for that open — and currently fails while doing so. Everything in
 * `measure-context-latency.mjs` describes the warm path; this script describes
 * the path a new user's first turn actually meets.
 *
 * Two details are load-bearing, and both were wrong in the first attempt:
 *
 *  - Each cold sample runs in a FRESH node subprocess. Reusing this process's
 *    undici pool across a daemon restart both hides the TCP connect a newly
 *    loaded plugin pays and trips over sockets to the dead daemon (ECONNRESET).
 *  - Query strings are made unique per request, so a cached result cannot be
 *    reported as retrieval latency. (Checked: it makes no difference here, but
 *    the measurement should not depend on that staying true.)
 *
 * It restarts a real daemon, so it needs a SodaMem checkout:
 *
 *   SODAMEM_DAEMON_CWD=/path/to/SodaMem \
 *   SODAMEM_DATA_ROOT=/path/to/store \
 *   SODAMEM_API_URL=http://127.0.0.1:8771 \
 *   SODAMEM_API_KEY=... SODAMEM_USER_ID=... \
 *   node scripts/measure-cold-start.mjs [rounds]
 *
 * It writes no file and invents no number: it prints what it measured.
 */
import { execFileSync } from "node:child_process";

const apiUrl = (process.env.SODAMEM_API_URL ?? "http://127.0.0.1:8771").replace(/\/+$/, "");
const apiKey = process.env.SODAMEM_API_KEY ?? "";
const userId = process.env.SODAMEM_USER_ID ?? "";
const daemonCwd = process.env.SODAMEM_DAEMON_CWD ?? "";
const dataRoot = process.env.SODAMEM_DATA_ROOT ?? "";
const rounds = Number(process.argv[2] ?? 10);
const WARM_PER_ROUND = 5;

if (!apiKey || !userId || !daemonCwd || !dataRoot) {
  console.error(
    "SODAMEM_API_KEY, SODAMEM_USER_ID, SODAMEM_DAEMON_CWD and SODAMEM_DATA_ROOT are required."
  );
  process.exit(2);
}

const QUERIES = [
  "where do I live?",
  "which airline did I fly to Boston?",
  "where do I work now?",
  "do I have a pet?",
];

const sleep = (ms) => execFileSync("/bin/sleep", [String(ms / 1000)]);

function sodamem(...args) {
  let last;
  // Restart churn makes the CLI's own control-plane call flaky; retry it
  // rather than reporting a measurement round that never happened.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return execFileSync(`${daemonCwd}/.venv/bin/sodamem`, args, {
        cwd: daemonCwd,
        env: { ...process.env, PATH: `${daemonCwd}/.venv/bin:${process.env.PATH}` },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      last = error;
      sleep(700);
    }
  }
  throw last;
}

/** Runs inside a fresh node process: one cold request, then some warm ones. */
const SAMPLER = `
const [base, key, user, warm, ...queries] = process.argv.slice(1);
async function ask(query) {
  const url = new URL("/v1/context", base);
  url.searchParams.set("user_id", user);
  url.searchParams.set("query", query);
  url.searchParams.set("token_budget", "1200");
  const t = performance.now();
  try {
    const r = await fetch(url, { headers: { Authorization: "Bearer " + key } });
    const raw = await r.text();
    const ms = performance.now() - t;
    return { ms, status: r.status, chars: r.ok ? (JSON.parse(raw).text ?? "").length : 0 };
  } catch (e) {
    return { ms: performance.now() - t, status: "ERR", chars: 0, error: String(e.cause ?? e) };
  }
}
const uniq = (i) => queries[i % queries.length] + " #" + Math.random().toString(36).slice(2, 8);
const out = { cold: await ask(uniq(0)), warm: [] };
for (let i = 0; i < Number(warm); i++) out.warm.push(await ask(uniq(i + 1)));
console.log(JSON.stringify(out));
`;

function sampleInFreshProcess() {
  const raw = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", SAMPLER, "--", apiUrl, apiKey, userId, String(WARM_PER_ROUND), ...QUERIES],
    { encoding: "utf8" }
  );
  return JSON.parse(raw);
}

const cold = [];
const second = [];
const steady = [];
let coldFailures = 0;

for (let round = 0; round < rounds; round++) {
  try {
    sodamem("daemon", "stop");
  } catch {
    /* not running */
  }
  sleep(600);
  sodamem("daemon", "ensure", "--api-url", apiUrl, "--api-key", apiKey, "--data-root", dataRoot);

  const { cold: first, warm } = sampleInFreshProcess();
  cold.push(first.ms);
  if (first.status !== 200) coldFailures++;
  if (warm[0]) second.push(warm[0].ms);
  for (const s of warm.slice(1)) steady.push(s.ms);

  console.log(
    `round ${round + 1}: cold ${first.ms.toFixed(0)}ms status=${first.status}` +
      `  then ${warm.map((s) => `${s.ms.toFixed(0)}${s.status === 200 ? "" : "!" + s.status}`).join("/")}ms`
  );
}

const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    n: s.length,
    min_ms: +s[0].toFixed(1),
    p50_ms: +at(0.5).toFixed(1),
    p95_ms: +at(0.95).toFixed(1),
    max_ms: +s[s.length - 1].toFixed(1),
    mean_ms: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1),
  };
};

console.log(
  "\n" +
    JSON.stringify(
      {
        apiUrl,
        userId,
        rounds,
        cold_first_request_after_restart: stat(cold),
        cold_non_200_responses: `${coldFailures}/${cold.length}`,
        second_request: stat(second),
        steady_state: stat(steady),
      },
      null,
      2
    )
);

try {
  sodamem("daemon", "stop");
} catch {
  /* ignore */
}
