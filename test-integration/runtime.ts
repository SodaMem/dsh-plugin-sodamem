/**
 * Real dsh runtime, booted the way dsh boots it.
 *
 * NOTHING here is a double except the LLM adapter: there is no model API key,
 * and the model's reply is not what these tests are about. The Cordis Context,
 * the session store, the system-prompt registry, the agent registry and the
 * concrete agent loop are the published packages, and the plugin is loaded
 * through `ctx.plugin()` exactly as a deployment loads it. `fetch` is the real
 * global; the daemon on the other end is a real SodaMem daemon.
 */
import { Context } from "@deepseek-ai/cordis";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import LlmRuntime, {
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import * as sodamem from "../src/index.js";
import type { SodaMemConfig } from "../src/config.js";

/** The populated bench store the daemon serves. */
export const DAEMON_URL = process.env.SODAMEM_TEST_URL ?? "http://127.0.0.1:8771";
export const DAEMON_KEY = process.env.SODAMEM_TEST_KEY ?? "benchkey";
export const DAEMON_USER = process.env.SODAMEM_TEST_USER ?? "bench";

/**
 * The one stub: an adapter that records the fully-assembled request and
 * answers with a fixed token. `GenerateOptions` is the model's-eye view — what
 * lands here is exactly what a real provider would have been sent.
 */
export class RecordingAdapter extends LlmAdapter {
  readonly seen: GenerateOptions[] = [];

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.seen.push(options);
    const chunks: StreamChunk[] = [
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: "ok" },
      { type: "block-end", index: 0, block: { type: "text", text: "ok" } },
      { type: "finish", reason: { kind: "stop" } },
    ];
    yield* chunks;
  }

  /** Flat text of one recorded request's messages. */
  messageText(index: number): string {
    const call = this.seen[index];
    if (!call) return "";
    return call.messages
      .map((message) =>
        (message.content as { type: string; text?: string }[])
          .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
          .join("\n")
      )
      .join("\n");
  }

  /** Every request's messages, flattened. */
  allText(): string {
    return this.seen.map((_, index) => this.messageText(index)).join("\n");
  }
}

export interface Runtime {
  ctx: Context;
  adapter: RecordingAdapter;
  /** Drive one real turn to completion. */
  ask(text: string): Promise<void>;
  dispose(): Promise<void>;
}

let seq = 0;

/** Boot the real runtime with the plugin loaded and one agent created. */
export async function bootRuntime(config: SodaMemConfig): Promise<Runtime> {
  const ctx = new Context();

  ctx.plugin(SessionStore);
  ctx.plugin(SystemPrompt);
  ctx.plugin(AgentRegistry);
  ctx.plugin(LlmRuntime);
  ctx.plugin(ToolRuntime);
  ctx.plugin(AgentLoop, { agents: [] });
  ctx.plugin(sodamem, config);

  // Cordis provisions services asynchronously; wait for `agentLoop` to exist.
  for (let i = 0; i < 200 && !(ctx as unknown as { agentLoop?: unknown }).agentLoop; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const adapter = new RecordingAdapter();
  const runtime = ctx as unknown as {
    llm: { registerAdapter(providers: string[], adapter: LlmAdapter): unknown };
    agents: { create(options: unknown): Promise<{ agent: Agentish; dispose(): Promise<void> }> };
  };
  runtime.llm.registerAdapter(["stub"], adapter);

  const handle = await runtime.agents.create({
    sessionId: SessionId(`integration-${++seq}-${Date.now()}`),
    agentOptions: { provider: "stub", model: "stub-model", maxTokens: 64 },
  });

  return {
    ctx,
    adapter,
    async ask(text: string) {
      handle.agent.followup(
        createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "user" },
        })
      );
      await handle.agent.whenIdle();
    },
    async dispose() {
      await handle.dispose();
    },
  };
}

interface Agentish {
  id: string;
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
}

/** Whether any recorded request carries a SodaMem evidence block. */
export function hasSodaMemEvidence(adapter: RecordingAdapter): boolean {
  return adapter.allText().includes("evidence_id=");
}
