# Changelog

All notable changes to this package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-08-18

**This is a documentation retraction, not a feature release. No plugin
behaviour changed.** If you read the 0.1.0 README or quoted its performance
numbers, read this entry.

### Retracted

Two published performance claims were wrong. Both were artifacts of the machine
they were measured on, not properties of the SodaMem daemon or of this plugin.

- **"Cold start returns HTTP 500 in 10 runs out of 10 — a Chroma panic in the
  lazy store open."** Withdrawn. There is no panic on a consistent chromadb
  install, and no SodaMem issue should be filed for one.
- **"Cold start p50 435 ms."** Withdrawn.
- **"Warm steady state p50 17 ms (p95 39 ms)."** Withdrawn. This understated
  real warm latency by roughly 7x.
- **"The 183 ms vs 14 ms discrepancy between benchmark runs is unexplained"**,
  and the hypothesis that the store handle was being re-opened per request.
  Both withdrawn; the discrepancy is resolved (see below).
- **Concurrency medians of 338 / 491 / 603 / 1179 ms** at concurrency
  1 / 2 / 4 / 8, and the conclusion drawn from them that *"at concurrency 8 the
  slowest sampled request was within 10% of the 1500 ms recall deadline."*
  Withdrawn and re-measured.

### Why they were wrong

The measurement machine had **two** chromadb installs — a project venv at
**1.1.1** and a homebrew Python at **1.5.8**. `sodamem daemon ensure` resolves
`uvicorn` from `PATH`, so one run opened the benchmark store on the homebrew
interpreter and let chromadb 1.5.8 **schema-migrate** it. Migration state is the
proof: the "panicking" store carries **10** `sysdb` migrations, every normally
built store carries **9**. chromadb 1.1.1 then slices from index 10 of its own
9-element list and panics.

It is a **chromadb downgrade**, not a daemon defect. Confirmed both directions:
1.5.8 opens that store cleanly, and stores built fresh under 1.1.1 never panic.

That also resolves the 183 ms / 17 ms discrepancy. The 183 ms run had working
vector search; the 17 ms run was the broken store answering **lexical-only**,
with every `vector_*` route at zero. They were never two measurements of the
same work — one was measuring **less work**.

### Corrected measurements

Clean 1000-fact store, chroma `sysdb` verified at 9, chromadb 1.1.1, daemon
pinned to the venv interpreter.

- **Cold start:** first request after restart returns **HTTP 200, 3 restarts out
  of 3**, 0 degraded, full vector routes. It costs about **630 ms** against a
  **~130 ms** steady state; the second request is already warm.
- **Warm steady state: p50 130 ms** (min 101, p95 164, p99 186, max 296), 200
  sequential requests.
- **Concurrency:** medians **128 / 211 / 361 / 672 ms** at concurrency
  1 / 2 / 4 / 8; worst-of-40 at concurrency 8 was **732 ms** on a quiet machine
  and **986–1268 ms** across five runs on a loaded one. Real headroom against
  the 1500 ms deadline, but between roughly 1.2x and 2x — not an order of
  magnitude.

Nothing was deleted. Every withdrawn figure is still in
[`NOTES-latency.md`](NOTES-latency.md), struck through and labelled, so anyone
who quoted one can see what happened and why.

### Changed

- `src/warmup.ts` keeps its place but loses its old justification. It was
  documented as absorbing a guaranteed panic; there is no panic. It stays
  because the other half survived re-measurement — the ~630 ms store open is
  real, and the plugin pays it at load so the user's first question does not.
- `NOTES-latency.md` reproduction steps now tell you to pin the interpreter and
  verify the store's chroma migration count before trusting any number.
- `NOTES-latency.md` and `CHANGELOG.md` are now included in the published
  package, so the retraction ships with the code rather than only living on
  GitHub.

## [0.1.0] - 2026-08-17

Initial release: unconditional per-turn recall on the `system-prompt/assemble`
waterfall, per-turn-close retain, and a load-time warm-up. Remote mode only —
the plugin is an HTTP client of the SodaMem daemon and never opens a store
itself.

**Its README and `NOTES-latency.md` carry the performance claims retracted in
0.1.1 above. Do not quote 0.1.0's performance section.**

[0.1.1]: https://github.com/SodaMem/dsh-plugin-sodamem/releases/tag/v0.1.1
[0.1.0]: https://github.com/SodaMem/dsh-plugin-sodamem/releases/tag/v0.1.0
