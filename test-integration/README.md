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

## Known failure: recall lands one turn late

`recall reaches the model > puts store evidence into the request for the turn
that asked` **fails**, and it is meant to: it asserts the requirement, and the
plugin does not meet it against the real loop.

`AgentLoop.preStep()` assembles the system prompt and projects the
runtime-context snapshot **before** it dispatches the `agent/pre-step`
waterfall:

```js
const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
const sections = renderContextSections(assembly);
const context  = this.runtimeContext.project(joinContextSections(sections), sections);
const decision = await this.dispatch.waterfall("agent/pre-step", { ... });
return { ...decision, assembly };
```

The plugin's design is the inverse: fetch in `agent/pre-step`, then let the
synchronous `systemPrompt.context` provider read the cache at assembly time.
That assembly has already happened. So turn N's recall is only visible to the
assembly that runs at the *end* of turn N, and reaches the model in turn N+1's
request — answering the previous question.

The companion test, `documents WHERE the evidence actually lands`, pins the
observed behaviour so that a fix makes it fail loudly.

The likely fix is to move recall onto the `system-prompt/assemble` waterfall,
which is asynchronous, carries the agent and the turn signal in its
`AssembleContext`, and whose return value is authoritative — removing the need
for the pre-step/cache two-step altogether.
