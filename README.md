# dsh-plugin-sodamem

A standalone plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) that wires in [SodaMem](https://github.com/SodaMem/SodaMem) as a persistent memory layer.

**New here?** SodaMem is an open-source long-term memory store for LLM agents: you ingest conversation turns into it and it extracts durable facts, then serves a prompt-ready evidence block back on demand. It runs as a local daemon. This repo is only the `dsh` plugin — the memory engine itself lives at [github.com/SodaMem/SodaMem](https://github.com/SodaMem/SodaMem), and you need it running for this plugin to do anything.

The plugin installs SodaMem as a **memory layer**, not as a tool in the model's tool bag.

- **Recall** — while every turn is being assembled, the plugin fetches a prompt-ready evidence block from SodaMem and contributes it to that turn's prompt.
- **Retain** — when every turn closes, the plugin ingests that turn's messages back into SodaMem.

Neither one is a tool call, so neither one depends on the model deciding to use it.

## Why not the MCP bridge?

SodaMem already has an MCP integration for `dsh`, in the main SodaMem repo ([`integrations/deepseek-harness/`](https://github.com/SodaMem/SodaMem/tree/main/integrations/deepseek-harness)). It exposes memory as **tools**, which means the model has to choose to call them — and on most turns it simply doesn't. The strongest thing SodaMem offers, the zero-LLM `GET /v1/context` evidence block, ends up left to the model's discretion.

MCP cannot fix that. A tool is pull-only, and nothing in the protocol lets a server contribute to the prompt or observe a turn closing. This plugin uses the two seams the harness itself exposes — `agent/pre-step` and `agent/turn-stopping` — so recall and retain happen unconditionally.

| | MCP bridge | This plugin |
|---|---|---|
| Recall | model calls a tool, if it decides to | every turn, automatically |
| Retain | model calls a tool, if it decides to | every closed turn, automatically |
| Model can skip it | yes | no |
| Costs tool-schema space | yes | no |

**Do not run both against the same store.** They would recall the same facts twice and ingest every turn twice. Pick one.

## Requirements

- Node >= 22 (the harness requires it; the plugin uses `AbortSignal.any`)
- A **running SodaMem daemon** — see below

## Install

```bash
dsh plugin --profile tui add dsh-plugin-sodamem
```

That is all that is needed. The package ships a `dsh.bundle` manifest pointing
at [`cordis.patch.yml`](./cordis.patch.yml), so `dsh` adds the plugin to the
profile's bundle list and composes its row — with working defaults — into the
profile tree. Confirm it landed:

```bash
dsh --profile tui --dump-config | grep -A6 'id: sodamem'
```

Start the daemon first (once per machine):

```bash
sodamem daemon ensure          # defaults to http://127.0.0.1:8000
```

Fact extraction needs LLM credentials on the **daemon** side. Put `SODAMEM_LLM_PROVIDER` / `SODAMEM_LLM_API_KEY` / `SODAMEM_LLM_MODEL` in the daemon's environment or `.env`. Without them recall still works, but every retain will be accepted and then fail during extraction.

## Configure

The bundled `cordis.patch.yml` ships defaults that boot (`apiUrl`
`http://127.0.0.1:8000`, `userId` `default`). To change them, override the row
in **your own** profile `cordis.patch.yml`, which applies after every bundle
layer:

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: sodamem
  config:
    apiUrl: 'http://127.0.0.1:8000'
    apiKey: 'dev'
    userId: 'your-user-id'
    tokenBudget: 1200
```

A patch **replaces** the targeted row's whole `config` rather than merging into
it, so restate every key you want to keep.

Without installing as a bundle, the same row can be inserted ad hoc:

```bash
npx @deepseek-ai/dsh web --patch ./sodamem-plugin.patch.yml
```

### Config fields

There are four, and they are all connection or scope facts.

| field | required | default | what it is |
|---|---|---|---|
| `apiUrl` | yes | — | Origin of the SodaMem daemon |
| `apiKey` | yes | — | Sent on every request. Any non-empty string works when the daemon runs with auth disabled — there is no magic fallback |
| `userId` | yes | — | The SodaMem `user_id` every read and write is scoped to |
| `tokenBudget` | no | `1200` | Token budget for the recalled evidence block |

There is deliberately **no switch that turns recall or retain on or off**, and no strategy selector. Auto-injection is the entire point of the plugin; a knob to disable it would just be a slower way to use the MCP bridge.

`session_id` on retain is the agent's id (in `dsh`, an agent and its session share one identity). `agent_id` is deliberately **not** sent — it would be the session id, which would narrow retrieval and fragment recall across sessions.

## Remote mode only

The plugin talks HTTP to a daemon. It has no data-root option and imports nothing that can open a store locally, and that is a deliberate constraint rather than an unfinished feature.

Two processes writing one `SODAMEM_DATA_ROOT` corrupt it — per-user SQLite without cross-process WAL is not safe under concurrent writers, which is why the daemon is pinned to a single worker (SodaMem [`mcp_server/README.md`](https://github.com/SodaMem/SodaMem/blob/main/mcp_server/README.md) and [ADR 0001 §2](https://github.com/SodaMem/SodaMem/blob/main/docs/adr/0001-control-plane-db.md)). A plugin loaded inside an arbitrary harness process is the worst possible candidate for being that second writer — you would not know how many of them are running. So there is exactly one writer, the daemon, and everyone else is a client.

## When SodaMem is down or slow

**A SodaMem problem is never a `dsh` problem.** Every call is wrapped so that no error, rejection, timeout, or abort escapes into the turn.

| | |
|---|---|
| Recall deadline | **1500 ms** |
| Retain deadline | **5000 ms** |
| Daemon unreachable, erroring, slow, or returning junk | recall contributes nothing; the turn proceeds normally |
| Turn cancelled | in-flight SodaMem requests are aborted with it |

The deadlines cover the **whole** call, headers and response body alike, so a daemon that answers `200` and then stalls mid-body cannot hang a turn.

Recall fires **once per question**, not once per prompt assembly — a tool loop that takes six steps still issues one `GET /v1/context`. Steering mid-turn is a new question, so it earns its own recall.

Retain ingests only what a human or the model actually said. Tool results and the harness's runtime-context snapshot are excluded — the snapshot is where this plugin's own recalled evidence lives, and ingesting it would feed the store its own output back on every turn.

The one thing to know: when recall misses its deadline, the turn proceeds *without memory* and nothing surfaces to the user. The plugin logs a warning (`ctx.logger.warn`) on every degraded turn, and that log is the only signal you get. See the performance note below.

On load the plugin also issues a couple of cheap warm-up requests, so the daemon's lazy store open — currently ~435 ms *and* an HTTP 500 — is paid before your first question instead of by it. Nothing waits on that warm-up, and it is harmless when no daemon is running yet.

## Performance

Measured on a real 1000-fact store (auth on, single-worker daemon, loopback, one machine). Full method, caveats, and reproduction steps: [`NOTES-latency.md`](NOTES-latency.md).

- **Cold start is the expensive one.** The daemon opens a user's store lazily, and across 10 real daemon restarts that first request took **p50 435 ms** and returned **HTTP 500 in 10 runs out of 10** — a Chroma panic in the lazy open. The plugin absorbs this with a fire-and-forget warm-up at load (`src/warmup.ts`), so the cost lands before the user's first question rather than on it. This is a daemon-side defect and should be fixed there too.
- **Warm, steady state: p50 17 ms** (p95 39 ms). That is what auto-injection adds to time-to-first-token once the store is open. It is the zero-LLM path, so it does not grow with model spend.
- **An earlier run of the same benchmark reported p50 183 ms / p99 471 ms and did not reproduce.** Both measurements are recorded in the notes rather than one replacing the other; the cause is not established, though the old figure matches today's *second* request (181.6 ms) almost exactly, which suggests the store handle was being re-opened. Do not quote a single warm number without reading the notes.
- **Multi-client is the caveat.** The daemon runs one worker by design, and `/v1/context` latency grows near-linearly with concurrent clients. At 8 concurrent clients the slowest sampled request was already within 10% of the 1500 ms recall deadline.

So: if a `dsh` turn, a Cursor hook, and a Claude Code hook all hit the same daemon, expect recall to start silently dropping. That is a property of the daemon's read path, not of this plugin — but auto-injection is what makes it reachable, by turning an occasional tool call into a per-turn one. The numbers behind this, including why the concurrency figures should be read as a shape rather than as precise milliseconds, are in `NOTES-latency.md`.

## Development

```bash
npm install
npm run typecheck
npm test          # no live daemon required; HTTP is mocked at the fetch boundary
npm run build     # dual ESM/CJS into dist/

npm run test:integration   # real dsh runtime + real daemon; not run by CI
```

`npm run test:integration` loads the plugin into a real `dsh` runtime — real
Cordis `Context`, real session store, real system-prompt registry, real agent
loop — and drives real turns against a running SodaMem daemon. It stubs only the
LLM adapter. See [`test-integration/README.md`](test-integration/README.md) for
how to start the daemon.

The unit tests cannot prove the plugin works inside the loop: they mock the
Cordis registration boundary, so they cannot see ordering. Treat the integration
suite as the gate.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
