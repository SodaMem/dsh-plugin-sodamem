# Integration tests — real dsh runtime, real SodaMem daemon

The 33 tests under `test/` mock HTTP at the `fetch` boundary and mock the
Cordis registration boundary. They prove the plugin's units behave; they cannot
prove the plugin works when dsh actually loads it. This suite closes that gap.

**What is real here:** the Cordis `Context`, `@deepseek-ai/dsh-session`,
`@deepseek-ai/dsh-system-prompt`, `@deepseek-ai/dsh-agent`, the concrete
`@deepseek-ai/dsh-agent-loop` driver, `@deepseek-ai/dsh-tools`, the global
`fetch`, and a running SodaMem daemon serving a populated store. The plugin is
loaded with `ctx.plugin(sodamem, config)` — the way a deployment loads it.

**The only stub** is the LLM adapter (`RecordingAdapter` in `runtime.ts`). We
have no model API key, and the model's reply is not what is under test. The
adapter records `GenerateOptions` — the fully assembled request — which is
precisely the model's-eye view of the turn.

## Running it

CI never runs this suite: `npm test` uses `vitest.config.ts`, which includes
only `test/**`. This suite has its own config.

Start a daemon on a populated store, then:

```sh
npm run test:integration
```

Point it elsewhere with `SODAMEM_TEST_URL`, `SODAMEM_TEST_KEY`,
`SODAMEM_TEST_USER` (defaults: `http://127.0.0.1:8771`, `benchkey`, `bench`).

The queries the tests use (`do I have a pet?`, `which airline did I fly to
Boston?`) must return distinct evidence from the store, since telling one
turn's recall from another's is the whole point of the recall tests.

## What each test pins down

| Test | Proves |
|---|---|
| `puts store evidence into the request for the turn that asked` | recall reaches the model on the asking turn |
| `answers each turn's own question, not the previous one` | no off-by-one: turn N's evidence answers turn N |
| `does not re-ask the daemon on every step of a tool loop` | one recall per question, not per prompt assembly |
| `completes normally with no memory and no throw` | a dead daemon costs memory, not the turn |
| `bounds the whole call and completes the turn anyway` | the deadline covers the response body |
| `issues POST /v1/memories to the real daemon on turn close` | retain really fires |
| `sends the closed turn's authored prose, and never its own recall` | retain body is right, and cannot feed the store its own output |

## History: the ordering bug this suite was built to find

The plugin originally fetched in `agent/pre-step` and served the result from a
synchronous `systemPrompt.context` provider. Every unit test passed and two
reviews missed it, because `AgentLoop.preStep()` assembles the prompt and
projects its runtime-context snapshot **before** it dispatches the
`agent/pre-step` waterfall:

```js
const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
const sections = renderContextSections(assembly);
const context  = this.runtimeContext.project(joinContextSections(sections), sections);
const decision = await this.dispatch.waterfall("agent/pre-step", { ... });
return { ...decision, assembly };
```

Turn N's recall was therefore only visible to the assembly at the *end* of turn
N, and reached the model in turn N+1's request — every answer was to the
previous question.

Recall now lives on the `system-prompt/assemble` waterfall, and the question
comes from `agent/inbox/claimed`, which fires while the loop claims the batch,
immediately before it assembles. Note that `assemble()` evaluates registered
context providers *eagerly*, before the waterfall runs, so warming a cache from
the waterfall would not have been enough either — the contribution has to be
pushed onto the assembly itself.

Fixing the ordering surfaced a second bug the old ordering had been hiding: with
the snapshot now landing inside the turn that recalled it, retain started
ingesting SodaMem's own evidence block back into SodaMem. `collectTurnMessages`
now keeps only `source.kind` `user` and `model` prose.
