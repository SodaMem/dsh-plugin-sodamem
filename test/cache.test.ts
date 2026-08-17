import { describe, expect, it } from "vitest";
import { RecallCache } from "../src/index.js";

describe("RecallCache", () => {
  it("accumulates every message claimed into one batch", () => {
    const cache = new RecallCache();
    cache.claim("agent-a", "first");
    cache.claim("agent-a", "second");

    expect(cache.take("agent-a")?.query).toBe("first\nsecond");
  });

  it("takes a batch exactly once, so a tool loop's later steps do not re-ask", () => {
    const cache = new RecallCache();
    cache.claim("agent-a", "question");

    expect(cache.take("agent-a")?.query).toBe("question");
    expect(cache.take("agent-a")).toBeUndefined();
    expect(cache.take("agent-a")).toBeUndefined();
  });

  it("opens a fresh batch once the previous one was taken", () => {
    const cache = new RecallCache();
    cache.claim("agent-a", "first question");
    cache.resolve("agent-a", cache.take("agent-a")!, "first answer");

    // Steering, or the next turn: a new claim is a new question.
    cache.claim("agent-a", "second question");
    expect(cache.take("agent-a")?.query).toBe("second question");
  });

  it("reads as 'no memory' between taking a batch and resolving it", () => {
    const cache = new RecallCache();
    cache.claim("agent-a", "question");
    const ticket = cache.take("agent-a")!;

    // The request is in flight: the previous turn's text must not leak here.
    expect(cache.get("agent-a")).toBe("");

    cache.resolve("agent-a", ticket, "answer");
    expect(cache.get("agent-a")).toBe("answer");
  });

  it("does not carry a resolved answer into the next question", () => {
    const cache = new RecallCache();
    cache.claim("agent-a", "first");
    cache.resolve("agent-a", cache.take("agent-a")!, "first answer");

    cache.claim("agent-a", "second");
    // The new batch has not been recalled for yet — the old answer is retired.
    expect(cache.get("agent-a")).toBe("");
  });

  it("takes nothing when the claimed batch carried no text", () => {
    const cache = new RecallCache();
    cache.claim("agent-a", "");

    expect(cache.take("agent-a")).toBeUndefined();
    expect(cache.get("agent-a")).toBe("");
  });

  it("takes nothing for an agent that never claimed", () => {
    const cache = new RecallCache();
    expect(cache.take("agent-a")).toBeUndefined();
  });

  it("keeps agents apart", () => {
    const cache = new RecallCache();
    cache.claim("agent-a", "q");
    cache.resolve("agent-a", cache.take("agent-a")!, "alpha");
    cache.claim("agent-b", "q");
    cache.resolve("agent-b", cache.take("agent-b")!, "beta");

    expect(cache.get("agent-a")).toBe("alpha");
    expect(cache.get("agent-b")).toBe("beta");
    expect(cache.get("agent-c")).toBe("");
    expect(cache.get(undefined)).toBe("");
  });

  it("a late answer cannot seal the question that replaced it", () => {
    const cache = new RecallCache();
    cache.claim("agent-a", "do I have a pet?");
    const stale = cache.take("agent-a")!;

    // The turn moves on before that request comes back.
    cache.claim("agent-a", "which airline?");
    const fresh = cache.take("agent-a")!;
    expect(fresh.generation).not.toBe(stale.generation);

    // The old request finally lands. It must not answer the new question.
    cache.resolve("agent-a", stale, "PET EVIDENCE");
    expect(cache.get("agent-a")).toBe("");

    cache.resolve("agent-a", fresh, "FLIGHT EVIDENCE");
    expect(cache.get("agent-a")).toBe("FLIGHT EVIDENCE");
  });

  it("a late answer cannot resurrect an agent that was disposed", () => {
    const cache = new RecallCache();
    cache.claim("agent-a", "question");
    const ticket = cache.take("agent-a")!;

    cache.delete("agent-a");
    cache.resolve("agent-a", ticket, "answer");

    // No orphan left behind in a map nothing else prunes.
    expect(cache.size).toBe(0);
    expect(cache.get("agent-a")).toBe("");
  });

  it("evicts one agent without touching the others, and clears everything", () => {
    const cache = new RecallCache();
    cache.claim("agent-a", "q");
    cache.resolve("agent-a", cache.take("agent-a")!, "alpha");
    cache.claim("agent-b", "q");
    cache.resolve("agent-b", cache.take("agent-b")!, "beta");

    cache.delete("agent-a");
    expect(cache.get("agent-a")).toBe("");
    expect(cache.get("agent-b")).toBe("beta");

    cache.clear();
    expect(cache.size).toBe(0);
  });
});
