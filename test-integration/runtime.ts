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
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
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
  /**
   * Optional per-request scripts. Index `i` drives the `i`-th request; once the
   * script runs out, every later request answers with plain text. Used to make
   * the model call a tool, so a turn really runs more than one step.
   */
  script: (StreamChunk[] | undefined)[] = [];

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.seen.length;
    this.seen.push(options);
    yield* this.script[index] ?? textReply("ok");
  }

  /** Flat text of one recorded request's messages. */
  messageText(index: number): string {
    const call = this.seen[index];
    if (!call) return "";
    return call.messages.map((message) => blockText(message.content)).join("\n");
  }

  /**
   * The SodaMem evidence block the model would read on request `index`.
   *
   * The harness carries recalled memory as a runtime-context snapshot message,
   * and a snapshot supersedes earlier ones, so the LAST snapshot in the
   * request is the memory in force for that turn.
   */
  evidenceText(index: number): string {
    const call = this.seen[index];
    if (!call) return "";
    const snapshots = call.messages
      .map((message) => blockText(message.content))
      .filter((text) => text.includes("evidence_id="));
    return snapshots[snapshots.length - 1] ?? "";
  }

  /**
   * The top-ranked evidence line of request `index`.
   *
   * The evidence block is a ranked list, and the tail of two different queries
   * legitimately overlaps on a store this dense — "do I have a pet?" and
   * "which airline did I fly to Boston?" both drag in some of each other's
   * facts further down. The FIRST line is the daemon's best answer, so it is
   * the honest signal for "this recall answered THIS question".
   */
  topEvidence(index: number): string {
    // The snapshot opens with the harness's own "Current runtime context…"
    // preamble, so skip to the first line the daemon actually produced.
    return this.evidenceText(index)
      .split("\n")
      .find((line) => line.startsWith("- evidence_id=")) ?? "";
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

/** Register a real, trivial tool so a scripted tool call actually dispatches. */
export const PING_TOOL = "ping";

/** Boot the real runtime with the plugin loaded and one agent created. */
export async function bootRuntime(
  config: SodaMemConfig,
  options: { withTool?: boolean } = {}
): Promise<Runtime> {
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
    tools: { register(definition: unknown): unknown };
    agents: { create(options: unknown): Promise<{ agent: Agentish; dispose(): Promise<void> }> };
  };
  runtime.llm.registerAdapter(["stub"], adapter);

  if (options.withTool) {
    runtime.tools.register(
      defineTool({
        name: PING_TOOL,
        description: "Answers pong. Exists so a turn can really run more than one step.",
        parameters: {},
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
        },
        execute: async () => "pong",
      })
    );
  }

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

/** A plain assistant text reply. */
export function textReply(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

/** An assistant turn that calls `name` once, forcing the loop to run another step. */
export function toolCallReply(callId: string, name: string): StreamChunk[] {
  const block = {
    type: "tool-call" as const,
    id: callId as never,
    name,
    arguments: {},
  };
  return [
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id: callId as never, name, argumentsDelta: "{}" },
    { type: "block-end", index: 0, block: block as never },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
}

function blockText(content: unknown): string {
  return (content as { type: string; text?: string }[])
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("\n");
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
