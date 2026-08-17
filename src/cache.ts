/**
 * Per-agent recall slot.
 *
 * One agent has at most one open question at a time, and recall answers that
 * question exactly once. The slot exists because the two halves of recall are
 * driven by different events: `agent/inbox/claimed` knows WHAT was asked, and
 * `system-prompt/assemble` is where the answer has to be contributed.
 *
 * The batch boundary is the seal, not the turn number. A batch opens when a
 * message is claimed, accumulates every message claimed alongside it, and
 * seals the moment recall is attempted for it. That is more precise than
 * keying on the turn:
 *
 * - the steps of a tool loop claim nothing, so they reuse the sealed answer
 *   instead of re-asking the daemon on every step;
 * - steering mid-turn DOES claim, so it opens a fresh batch and the question
 *   it introduced gets its own answer.
 *
 * Keyed by agent id, so two agents never see each other's memory.
 */

export interface RecallEntry {
  /**
   * Monotonic batch identity. Every new batch gets a fresh one, so an answer
   * can be matched to the question it was asked for.
   */
  readonly generation: number;
  /** The claimed text this recall answers. */
  readonly query: string;
  /** `undefined` while the batch is open; set once recall has been attempted. */
  readonly text: string | undefined;
}

/** What {@link RecallCache.take} hands back: a question and its identity. */
export interface RecallTicket {
  readonly generation: number;
  readonly query: string;
}

export class RecallCache {
  private readonly entries = new Map<string, RecallEntry>();
  private generations = 0;

  /**
   * Record one claimed message, opening a new batch or extending the open one.
   *
   * `agent/inbox/claimed` fires once per message, so a multi-message batch
   * arrives as several calls before the assembly that consumes it.
   */
  claim(agentId: string, text: string): void {
    const entry = this.entries.get(agentId);
    if (entry !== undefined && entry.text === undefined) {
      const query = entry.query && text ? `${entry.query}\n${text}` : entry.query || text;
      this.entries.set(agentId, { generation: entry.generation, query, text: undefined });
      return;
    }
    this.entries.set(agentId, { generation: ++this.generations, query: text, text: undefined });
  }

  /**
   * Seal the open batch and return the query to recall for.
   *
   * Sealing BEFORE the request is deliberate and load-bearing: it makes the
   * answer "no memory" until the response lands, so a concurrent assembly
   * cannot issue a second request and every failure below already reads
   * correctly without a second code path.
   *
   * @returns a ticket naming the question and its batch, or `undefined` when
   *   there is no open batch or the batch carried no text worth asking about.
   */
  take(agentId: string): RecallTicket | undefined {
    const entry = this.entries.get(agentId);
    if (entry === undefined || entry.text !== undefined) return undefined;
    this.entries.set(agentId, { generation: entry.generation, query: entry.query, text: "" });
    if (!entry.query) return undefined;
    return { generation: entry.generation, query: entry.query };
  }

  /**
   * Record the recalled text for the batch the ticket names.
   *
   * The generation check is what makes a late answer harmless. Without it, a
   * request that outlives its question would seal a NEWER batch with the
   * PREVIOUS question's evidence — a local rerun of the off-by-one this whole
   * design exists to prevent. The loop happens to be serial per agent today,
   * so this is unreachable by accident rather than by construction; the check
   * makes it unreachable by construction.
   *
   * It also refuses to resurrect an agent evicted by `agent/disposed` while
   * its request was in flight, which would otherwise leave an entry nothing
   * ever prunes.
   */
  resolve(agentId: string, ticket: RecallTicket, text: string): void {
    const entry = this.entries.get(agentId);
    if (entry === undefined || entry.generation !== ticket.generation) return;
    this.entries.set(agentId, { generation: entry.generation, query: entry.query, text });
  }

  /** The text to contribute for this agent, or `''` when there is none. */
  get(agentId: string | undefined): string {
    if (!agentId) return "";
    return this.entries.get(agentId)?.text ?? "";
  }

  delete(agentId: string): void {
    this.entries.delete(agentId);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
