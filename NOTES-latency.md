# Measured `GET /v1/context` latency

*(Originally written as acceptance criterion AC7 of [SodaMem
#9](https://github.com/SodaMem/SodaMem/issues/9), the issue this plugin was
built under. "AC7" below refers to that.)*

Recall sits on the synchronous path between the user pressing enter and the
first token, and the SodaMem daemon runs `--workers 1` by design ([SodaMem ADR
0001 §2](https://github.com/SodaMem/SodaMem/blob/main/docs/adr/0001-control-plane-db.md)
— single worker is a correctness constraint there, not a performance choice). So the
1500 ms recall deadline is set from a measurement, not a hope.

**Every number in this file was produced by a run against a live daemon backed
by a real, populated store. Nothing here is estimated.** (An earlier pass could
only measure an empty store and said so; that floor is superseded and has been
removed.)

That was true and still was not enough. Several numbers here were produced by a
live daemon against a real store that was **broken in a way the measurement
could not see**, and they were published as findings. They are withdrawn below,
kept visible, and explained. **Read the retraction before quoting anything from
this file.**

---

## RETRACTION (2026-08-18) — the cold-start finding and the warm p50 are withdrawn

**Two published claims in this file were wrong, and they were wrong for the
same reason.**

**No withdrawn FIGURE has been deleted** — every retracted number stays below,
struck through and labelled, so anyone who quoted one can see what happened.
**Some withdrawn PROSE was rewritten in place rather than struck through:** the
sentence claiming the integration test gated the warm-up, the "how firm is that
margin" paragraph under the operational consequence, and the original
absolute-milliseconds caveat under the concurrency table. Each of those is
called out at the point where it was changed, but the old wording is in git
history rather than on this page. If you are checking a quotation against this
file and cannot find it, check `git log -p NOTES-latency.md`.

### What was withdrawn

| Claim as published | Status |
|---|---|
| "The first request after a daemon restart returns **HTTP 500, 10 runs out of 10** — a Chroma panic in the lazy open" | **WITHDRAWN.** Test-machine artifact, not a daemon defect. |
| "Cold start **p50 435 ms**" | **WITHDRAWN.** Measured against the same broken store. |
| "Warm steady state **p50 17.1 ms** (p95 38.8 ms)" | **WITHDRAWN.** ~7x too fast — it was measuring a store with no working vector search. |
| "The re-measured sequential p50 of **14.2 ms** vs the published 182.6 ms is an unexplained discrepancy" | **RESOLVED.** See below — they were never measuring the same store. |
| Concurrency table (338 / 491 / 603 / 1179 ms medians) | **WITHDRAWN and re-measured.** Same broken store. |

### Root cause: two chromadb installs on the measurement machine

This machine has **two** chromadb installations — the project venv at
**1.1.1**, and a homebrew Python at **1.5.8**. `sodamem daemon ensure` resolves
`uvicorn` from `PATH`. One run picked up the homebrew interpreter, so the
benchmark store was opened, and its chroma schema **migrated**, by chromadb
**1.5.8**.

The migration state is the proof:

| store | chroma `sysdb` migrations | latest |
|---|---|---|
| the store all the withdrawn numbers were taken on | **10** | `00010-collection-schema` |
| every store built and opened normally | **9** | `00009-segment-collection-not-null` |

chromadb 1.1.1 then slices from index 10 of its own 9-element migration list:

```
pyo3_runtime.PanicException: range start index 10 out of range for slice of length 9
  at rust/sqlite/src/db.rs:157
```

Confirmed in both directions: chromadb **1.5.8 opens that same store cleanly**
(3 collections, 1000 vectors), and stores built fresh under 1.1.1 **never
panic**. So the panic is a **chromadb downgrade**, not a daemon defect. A user
on one consistent chromadb does not hit it.

### This also resolves the 183 ms vs 17 ms discrepancy

The section below originally recorded that discrepancy as unexplained. It is
not a mystery — the two runs were not measuring the same thing:

- The **182.6 ms** run had a **healthy** store: vector search working, no
  degraded routes.
- The **17.1 ms** run was the **broken** store: chroma dead, retrieval fell
  back to lexical-only (`degraded: [vector_route_failed x3]`, every `vector_*`
  route 0).

17 ms was not a faster measurement of the same work. It was a measurement of
**less work** — the vector half of retrieval was simply not running. **17 ms is
the wrong number and understates the real cost by roughly 7x.**

### The corrected measurements

All taken on a clean 1000-fact store (chroma `sysdb` at 9 migrations, verified),
venv chromadb **1.1.1**, daemon launched on the venv interpreter (venv `bin`
first on `PATH` — get that wrong and you measure the wrong thing, which is
exactly what happened).

**Cold start — 3 daemon restarts, first request each time:**

```
restart 1: first request HTTP 200 | 0 degraded / 17 citations
restart 2: first request HTTP 200 | 0 degraded / 17 citations
restart 3: first request HTTP 200 | 0 degraded / 17 citations
```

No panic, no 500, full vector routes, 3 out of 3.

Reproduced independently with `scripts/measure-cold-start.mjs 3` against the
same store, which also puts a number on what the store open costs:

```
round 1: cold 880ms status=200  then 152/134/127/125/182ms
round 2: cold 633ms status=200  then 136/129/136/126/136ms
round 3: cold 619ms status=200  then 135/128/130/129/138ms

cold first request after restart : n=3  min 619.3  p50 632.8  max 879.7  (ms)
non-200 responses               : 0/3
second request                  : n=3  min 134.7  p50 135.8  max 151.8  (ms)
steady state                    : n=12 min 124.7  p50 130.1  max 181.8  (ms)
```

So the first request after a daemon start **succeeds**, and costs roughly
**500 ms more than steady state** — a real, one-time store-open cost, with no
failure attached. The *second* request is already at steady state.

**Warm latency — same harness as the sequential table below, 200 sequential
requests, same six queries:**

```
min 100.8 | p50 130.2 | p95 163.9 | p99 186.4 | max 296.1  (ms)
```

**130 ms is the honest warm p50.** Not 17 ms, and not 183 ms.

---

## How the store was built — no LLM key required

The first pass reported AC7 as blocked: `POST /v1/memories` refuses every write
without an extractor, so with no `SODAMEM_LLM_API_KEY` there was nothing to
measure against. That blocker was soluble. `sodamem.llm.testing.ScriptedProvider`
feeds `FactEventExtractorV2` a pre-set response per call, which drives the
**real** ingest path — real fact rows, real source spans, real entity roles,
real MiniLM embeddings from the cached model — with **zero LLM network calls**.

Build script: `scripts/populate_store.py <data_root> <user_id> <n_facts>`.

**Precondition.** That script is Python and imports `sodamem` internals
(`sodamem.llm.testing.ScriptedProvider`, `sodamem.memory.ingest.extractor`).
This repo is a TypeScript package and does not ship or install it, so
`populate_store.py` cannot run from a bare checkout of this repo. Reproducing
the store — and therefore the measurement — requires a
[SodaMem](https://github.com/SodaMem/SodaMem) checkout with the Python package
installed (`pip install -e ".[dev,chroma,server,llm]"`). The two `.mjs` probe
scripts have no such dependency: they speak plain HTTP to a running daemon and
run on Node alone.

Resulting store:

| | |
|---|---|
| `fact_events` | 1000 |
| `source_spans` | 1000 |
| `raw_turns` | 1000 |
| chroma `embeddings` | 3000 |
| on disk | 23 MB |

The generator rotates four predicate families (`travel_by_airline`,
`employed_by`, `owns_pet`, `resides_in`) across 12 cities, 6 airlines, 6
employers, and 5 pets, so retrieval has genuine competition to rank rather than
N copies of one fact.

Daemon: `sodamem daemon ensure`, auth **enabled**, `--workers 1`, on
`127.0.0.1:8771`.

## Sequential — one client, 200 requests

`node scripts/measure-context-latency.mjs 200`, with these six store-relevant
queries supplied via `SODAMEM_QUERIES` (`|`-separated) rather than the script's
generic built-in set:

```
where do I live?
which airline did I fly to Boston?
where do I work now?
do I have a pet?
what city did I move to?
tell me about my flights
```

`token_budget` 1200, one warm-up request excluded. The concurrency probe uses
the same six (the `QUERIES` array in `scripts/concurrency_probe.mjs`).

| metric | ms |
|---|---|
| min | 112 |
| **p50** | **182.6** |
| p95 | 323 |
| **p99** | **471.1** |
| max | 596.4 |

**Kept as published, for the record.** These numbers were taken on a healthy
store, and the retraction above explains why they read high against the 17 ms
run rather than the other way round: 17 ms was the broken store. The honest
warm figure from the clean re-measurement is **p50 130.2 ms** (min 100.8, p95
163.9, p99 186.4, max 296.1) — same script, same six queries, same
`token_budget`. The 182.6 ms table is not withdrawn, but **quote 130 ms**: it
is the one taken on a store whose chroma schema was verified, on a daemon whose
interpreter was verified.

They also describe a **warm** daemon only; the first request after a start
costs ~500 ms more (see the retraction above).


## Cold start — WITHDRAWN AS PUBLISHED, corrected below

> **This whole section is withdrawn.** Everything in it was measured against a
> store whose chroma schema had been migrated by a different chromadb (1.5.8)
> than the one reading it (1.1.1). See the
> [retraction](#retraction-2026-08-18--the-cold-start-finding-and-the-warm-p50-are-withdrawn).
> The text below is kept verbatim so the claim and its withdrawal sit together;
> **do not quote it.**

### What was published (withdrawn)

Everything above measures a daemon that has already served a request for this
user. That is not the state a new user's first turn meets.

The daemon opens a user's store **lazily**, on the first request that touches
it. Measured across **10 real daemon restarts**, each sampled from a fresh Node
process so the TCP connect is included the way a newly loaded plugin pays it
(`scripts/measure-cold-start.mjs`):

| | first request after restart | second request | steady state (requests 3+) |
|---|---|---|---|
| n | 10 | 10 | 40 |
| min | ~~420.2 ms~~ | ~~162.6 ms~~ | ~~15.6 ms~~ |
| **p50** | ~~**435.3 ms**~~ | ~~**181.6 ms**~~ | ~~**17.1 ms**~~ |
| p95 | ~~838.3 ms~~ | ~~220.4 ms~~ | ~~38.8 ms~~ |
| max | ~~838.3 ms~~ | ~~220.4 ms~~ | ~~39.6 ms~~ |
| outcome | ~~**HTTP 500, 10 runs out of 10**~~ | 200 | 200 |

The claim made was: the first request does not merely cost more — **it fails**,
panicking inside Chroma's Rust bindings:

```
File "server/stores.py", line 123, in get
    mem = SodaMem.open(path, extractor=self._build_extractor())
File "chromadb/api/rust.py", line 114, in start
    self.bindings = chromadb_rust_bindings.Bindings(
pyo3_runtime.PanicException: range start index 10 out of range for slice of length 9
```

That was called "a **daemon-side defect** deserving its own issue against
SodaMem".

### Why it was wrong

It is not a daemon defect. The panic is a **chromadb downgrade**: a store whose
schema was migrated to 10 migrations by chromadb 1.5.8, then opened by chromadb
1.1.1, which knows only 9. Root cause and proof are in the
[retraction](#root-cause-two-chromadb-installs-on-the-measurement-machine).
The measurement machine had both versions installed and `sodamem daemon ensure`
resolved `uvicorn` from `PATH`, so which chromadb touched the store came down
to which interpreter won the `PATH` lookup.

No SodaMem issue should be filed for this panic. Users on one consistent
chromadb do not hit it.

### What is actually true

On a clean store, the first request after a restart **returns 200 with full
vector routes, 3 restarts out of 3**, and costs roughly **500 ms more than
steady state** (p50 632.8 ms cold against 130.1 ms steady, n=3 restarts). The
second request is already warm. Numbers and raw output are in
[The corrected measurements](#the-corrected-measurements).

So the cold-start cost is **real but ordinary**: a one-time store open, no
failure attached.

### What the plugin does about it

`src/warmup.ts` issues a cheap `GET /v1/context` (`token_budget=100`) when the
plugin loads, fire-and-forget. Nothing awaits it, it never throws, and it stops
on unload — booting with no daemon at all is an ordinary way to start.

Its **original justification is withdrawn**: it was described as absorbing a
guaranteed panic, and there is no panic. It is kept because the *other* half of
the justification survives measurement — the first request after a daemon start
really does cost ~633 ms against a ~130 ms steady state, and something has to
pay that. The warm-up makes it the plugin's cost at load rather than the user's
cost on their first question. It retries once, but as an ordinary retry for a
transient failure, not because attempt 1 is expected to fail.

**The `cold start` integration test no longer gates this, and this file used to
claim it did.** The withdrawn version said the effect was "verified end to end"
by that test, and that was true only while the cold request was believed to
fail: with the warm-up removed, the first turn got no memory at all. On the
corrected facts a ~630 ms cold request comfortably clears the 1500 ms recall
deadline, so **that test would now pass with `src/warmup.ts` deleted.** It is
still a real test — it restarts the daemon and asserts actual evidence content
through the real runtime — but it proves that cold start does not cost the
first turn its memory, not that the warm-up is what prevents that. **The
warm-up's justification is a latency measurement, and nothing in the test suite
currently holds it in place.**

## Re-measurement: RESOLVED — the two runs were measuring different stores

> The original text of this section recorded the 183 ms / 17 ms gap as an
> unexplained discrepancy with "the cause has not been established". **The
> cause is now established, and the conclusion this section reached was
> backwards.** Kept, corrected in place.

Re-running the sequential benchmark — same script, same six queries, same
`token_budget`, same machine — produced numbers an order of magnitude faster
than the published ones:

| metric | published (healthy store) | re-measured (BROKEN store) | corrected (clean store) |
|---|---|---|---|
| p50 | 182.6 ms | ~~14.2 ms~~ | **130.2 ms** |
| p95 | 323 ms | ~~36.1 ms~~ | **163.9 ms** |
| p99 | 471.1 ms | ~~56.1 ms~~ | **186.4 ms** |
| max | 596.4 ms | ~~77.2 ms~~ | **296.1 ms** |

Result caching was ruled out at the time (200 unique query strings gave p50
15.4 ms, statistically the same as 200 repeats of six queries), and that ruling
was correct — it just was not the explanation.

**The explanation is that the fast run was not doing the work.** The ~14–17 ms
run was taken against the store whose chroma had been schema-migrated by
chromadb 1.5.8: chroma failed to open, retrieval degraded to lexical-only
(`degraded: [vector_route_failed x3]`, all `vector_*` routes 0), and the vector
half of retrieval never ran. The 182.6 ms run had working vector search.

The two runs were never two measurements of the same thing. One was measuring
**less work**.

The hypothesis previously recorded here — that the 182.6 ms figure was the
store handle being re-opened per request, because 182.6 is close to the
"second request" figure of 181.6 — is **withdrawn**. That resemblance was a
coincidence between two numbers from the same contaminated session. The clean
store's steady-state p50 is 130 ms, its second-request p50 is 136 ms, and its
cold first request is 633 ms; there is no per-request re-open.

**Corrected guidance:** treat `/v1/context` warm latency as **~130 ms p50**.
The "~17 ms p50 in steady state" figure this file previously published is
withdrawn and understates by roughly 7x.

The concurrency table below was taken in the same contaminated session and has
been re-measured accordingly.

## Concurrent — the `--workers 1` question

The sequential table describes one client. The real deployment is a dsh turn
racing a Cursor hook and a Claude Code hook against the same single worker.
Probe: `node scripts/concurrency_probe.mjs`, 5 rounds per level.

**The originally published table is withdrawn** — it came from the same
contaminated store as the withdrawn cold-start and 17 ms figures, so it
described a store with **no working vector search**, i.e. less work per
request. It has been re-measured on the clean store.

### Re-measured (clean store, chromadb 1.1.1, chroma `sysdb` 9)

| concurrency | n | median ms | worst-of-n ms |
|---|---|---|---|
| 1 | 5 | 128.4 | 188.4 |
| 2 | 10 | 211.2 | 234.3 |
| 4 | 20 | 361.2 | 411.7 |
| 8 | 40 | 671.6 | 731.8 |

Raw output of the run this table is taken from, and of the run immediately
before it, so the reproducibility is visible rather than asserted:

```
# run 1 (first probe after daemon start — BM25 cache still cold)
concurrency=1  n=5   p50=166.1ms  worst=224.9ms
concurrency=2  n=10  p50=211.4ms  worst=242.1ms
concurrency=4  n=20  p50=344.6ms  worst=395.1ms
concurrency=8  n=40  p50=638.6ms  worst=728.1ms

# run 2 (tabled above)
concurrency=1  n=5   p50=128.4ms  worst=188.4ms
concurrency=2  n=10  p50=211.2ms  worst=234.3ms
concurrency=4  n=20  p50=361.2ms  worst=411.7ms
concurrency=8  n=40  p50=671.6ms  worst=731.8ms
```

It still queues, roughly linearly. The **shape** is the finding that survived
the retraction unchanged; only the absolute numbers moved.

**These two runs were taken on an otherwise idle machine.** An independent
re-measurement on the same store on a loaded machine (load avg 14) ran the
probe five times and got worst-of-40 at concurrency 8 of
**986 / 1101 / 1121 / 1178 / 1268 ms** — consistent with the table once
you account for the ~1.5x that machine also cost on the sequential harness, but
a reminder that the table's absolute milliseconds are a property of a quiet
box. See [Operational consequence](#operational-consequence--state-this-plainly).

### Withdrawn (do not quote)

| concurrency | n | median ms | worst-of-n ms |
|---|---|---|---|
| 1 | 5 | ~~338.3~~ | ~~400.8~~ |
| 2 | 10 | ~~491.1~~ | ~~532.4~~ |
| 4 | 20 | ~~603.4~~ | ~~816.7~~ |
| 8 | 40 | ~~1179.3~~ | ~~1379.1~~ |

Note the direction: the withdrawn table read **higher** at every level despite
measuring a *lexically degraded* store. Whatever else that session was doing,
it was not a like-for-like of the clean one, which is the whole reason it is
withdrawn rather than adjusted.

### Caveat — the right-hand column is a maximum, not a p99

The probe labels that column `p99`, and at these sample sizes that label is
wrong. Its percentile helper resolves `p99` to
`sorted[ceil(0.99 * n) - 1]`, which for n = 5, 10, 20, and 40 is `sorted[n-1]`
— the **largest sample**, every time. So the concurrency-8 figure of 731.8 ms
is the worst of 40 requests, not a 99th percentile, and a single sample does
not deserve to be quoted to a tenth of a millisecond.

The column is relabelled here to say what the number actually is. The median
column is a genuine (lower) median at every level and is unaffected. This
caveat applies to the re-measured table exactly as it applied to the withdrawn
one.

### Caveat — do not read these as absolute milliseconds

On the clean store the probe and the sequential harness now **agree** at
concurrency 1 — 128.4 ms probe median against 130.2 ms sequential p50 — where
the withdrawn table showed the probe reading ~1.9x high. That agreement is the
warm case, and it is not guaranteed: run 1 above, taken immediately after
daemon start, read 166.1 ms at the same level, because five rounds do not warm
the BM25 index cache the way 200 sequential requests do. So the probe reads
**high when cold and level when warm**, which is a smaller and better-behaved
error than the withdrawn text described — but it is still an error, and it is
still why the absolute milliseconds here should not be quoted on their own.

The reliable output of the probe is the **shape** — near-linear queueing under
concurrency. For absolute latency, use the corrected sequential figure.

### Caveat — scope of the whole measurement

One machine, over loopback, against one store profile (1000 facts, the four
synthetic predicate families above). Different hardware, a real network hop, a
larger or differently-shaped store, or a different query mix will move these
numbers. Nothing here has been reproduced on a second machine.

**And one more, learned the hard way:** nothing here was reproduced under a
second chromadb version either. The retraction above exists because two
chromadb installs on one machine silently produced a store that one of them
could not open. If you reproduce this, pin the interpreter — put the venv's
`bin` first on `PATH` — and check `select count(*) from migrations where
dir='sysdb'` in the store's `chroma/chroma.sqlite3` before trusting a number.

## Operational consequence — state this plainly

**This section's headline figure changed with the retraction, and it changed in
the direction that makes the plugin look better — which is exactly why it is
spelled out rather than quietly swapped.**

Withdrawn: *"At concurrency 8, the slowest of 40 requests took 1379 ms — inside
10% of the plugin's 1500 ms recall deadline."* That came from the contaminated
store.

Re-measured on an otherwise idle machine: at concurrency 8, the slowest of 40
requests took **731.8 ms**, median **671.6 ms** — a margin of roughly **2x**
against the 1500 ms deadline, not 10%.

**That 2x is the quiet-machine best case, and quoting it alone would be the
same mistake in the other direction.** An independent re-measurement on the
same store, on a *loaded* machine (load avg 14, sequential p50 196.8 ms against
this file's 130.2 ms), ran the probe five times and got worst-of-40 at
concurrency 8 of:

```
986 / 1101 / 1121 / 1178 / 1268 ms
```

That is a **1.2x–1.5x** margin, with the worst run inside 16% of the deadline.
Scaled by the ~1.5x the loaded machine costs on the sequential harness too,
those runs are consistent with 731.8 ms rather than a refutation of it — the
two measurements agree about the machine, not about a headline number.

So the honest statement is: **at 8 concurrent clients there is real headroom on
the deadline, somewhere between roughly 1.2x and 2x depending on what else the
box is doing.** That is meaningfully better than the withdrawn "within 10%",
and it is not "recall is safe at 8 clients". Nothing measured on either machine
shows recall actually missing its deadline; the loaded machine shows how little
it would take.

What is *not* softened is the direction and the shape: latency grows
near-linearly with concurrent clients (128 → 211 → 361 → 672 ms median at 1, 2,
4, 8), and the deadline is a fixed 1500 ms. Extrapolating the same slope on the
idle machine, the deadline comes into reach somewhere around 16 concurrent
clients; on the loaded machine, closer to 10. Both are extrapolations, not
measurements, and are labelled as such. The probe was not run past 8 on either.

When recall does drop, the plugin does the safe thing: it caches `''`,
contributes no memory, and the turn proceeds normally. Nothing breaks and
nothing blocks.

But **the failure is silent.** There is no error surfaced to the user and no
degraded turn — memory simply, quietly, stops working under multi-client load.
A deployment that adds enough concurrent SodaMem clients can lose recall
entirely without anyone noticing that anything changed. That is the property to
watch, and it is why the plugin logs a warning on every degraded turn
(`ctx.logger.warn`) even though it never raises.

## The concurrency ceiling is not a plugin defect

The read path not scaling past a handful of concurrent clients is a **SodaMem
daemon property**: one worker by design ([SodaMem ADR 0001
§2](https://github.com/SodaMem/SodaMem/blob/main/docs/adr/0001-control-plane-db.md)),
pre-existing, and
entirely independent of this plugin.

What this plugin changes is **reachability**. Over the MCP bridge, `/v1/context`
was an occasional tool call the model had to choose to make. Auto-injection
makes it a *per-turn* call on every turn of every agent. The same ceiling that
was previously hard to reach is now reached by ordinary use with a few clients
attached.

That deserves its own issue against the daemon's read concurrency. It is
**explicitly out of scope for [SodaMem
#9](https://github.com/SodaMem/SodaMem/issues/9)**, the issue this plugin was
built under — this plugin's job is to degrade safely
when the ceiling is hit, which it does and which is tested.

## Reproducing

All four scripts live in this repo, under `scripts/`, and the commands below
are written from this repo's root. Step 1 additionally needs the `sodamem`
**Python** package importable — install it from a
[SodaMem](https://github.com/SodaMem/SodaMem) checkout first (see the
precondition above). Steps 2–4 need only Node and a reachable daemon.

```sh
# 1. Build a real store, no LLM key needed.
#    Requires the sodamem Python package on sys.path.
python scripts/populate_store.py <data_root> <user_id> 1000

# 2. Start the daemon on that store.
#    PUT THE VENV'S bin FIRST ON PATH. `daemon ensure` resolves `uvicorn` from
#    PATH, and a second Python with a different chromadb winning that lookup is
#    what produced every withdrawn number in this file.
export PATH=/path/to/SodaMem/.venv/bin:$PATH
sodamem daemon ensure --api-url http://127.0.0.1:8771 \
  --api-key <key> --data-root <data_root>

# 2b. Verify you are measuring what you think you are measuring.
ps aux | grep uvicorn                      # is it the venv's python?
python -c 'import chromadb; print(chromadb.__version__)'
sqlite3 <data_root>/<user_id>/chroma/chroma.sqlite3 \
  "select dir, count(*) from migrations group by dir;"   # sysdb must be 9 for chromadb 1.1.1

# 3. Sequential latency.
SODAMEM_API_URL=http://127.0.0.1:8771 SODAMEM_API_KEY=<key> \
SODAMEM_USER_ID=<user_id> SODAMEM_QUERIES='where do I live?|where do I work now?' \
  node scripts/measure-context-latency.mjs 200

# 4. Concurrency shape.
SODAMEM_API_URL=http://127.0.0.1:8771 SODAMEM_API_KEY=<key> \
SODAMEM_USER_ID=<user_id> node scripts/concurrency_probe.mjs

# Cold start (restarts the daemon, so it needs a SodaMem checkout):
SODAMEM_DAEMON_CWD=/path/to/SodaMem \
SODAMEM_DATA_ROOT=<data_root> \
SODAMEM_API_URL=http://127.0.0.1:8771 \
SODAMEM_API_KEY=<key> SODAMEM_USER_ID=<user_id> \
node scripts/measure-cold-start.mjs 3
```
