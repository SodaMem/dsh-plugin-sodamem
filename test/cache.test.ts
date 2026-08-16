import { describe, expect, it } from "vitest";
import { RecallCache } from "../src/index.js";

describe("RecallCache", () => {
  it("accumulates every message claimed into one batch", () => {
    const cache = new RecallCache();
    cache.claim("agent-a", "first");
    cache.claim("agent-a", "second");

    expect(cache.take("agent-a")).toBe("first\nsecond");
  });

  it("takes a batch exactly once, so a tool loop's later steps do not re-ask", () => {
    const cache = new RecallCache();
    cache.claim("agent-a", "question");

    expect(cache.take("agent-a")).toBe("question");
    expect(cache.take("agent-a")).toBeUndefined();
    expect(cache.take("agent-a")).toBeUndefined();
  });

  it("opens a fresh batch once the previous one was taken", () => {
    const cache = new RecallCache();
    cache.claim("agent-a", "first question");
    cache.take("agent-a");
    cache.resolve("agent-a", "first answer");

    // Steering, or the next turn: a new claim is a new question.
    cache.claim("agent-a", "second question");
    expect(cache.take("agent-a")).toBe("second question");
  });

  it("reads as 'no memory' between taking a batch and resolving it", () => {
    const cache = new RecallCache();
    cache.claim("agent-a", "question");
    cache.take("agent-a");

    // The request is in flight: the previous turn's text must not leak here.
    expect(cache.get("agent-a")).toBe("");

    cache.resolve("agent-a", "answer");
    expect(cache.get("agent-a")).toBe("answer");
  });

  it("does not carry a resolved answer into the next question", () => {
    const cache = new RecallCache();
    cache.claim("agent-a", "first");
    cache.take("agent-a");
    cache.resolve("agent-a", "first answer");

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
    cache.take("agent-a");
    cache.resolve("agent-a", "alpha");
    cache.claim("agent-b", "q");
    cache.take("agent-b");
    cache.resolve("agent-b", "beta");

    expect(cache.get("agent-a")).toBe("alpha");
    expect(cache.get("agent-b")).toBe("beta");
    expect(cache.get("agent-c")).toBe("");
    expect(cache.get(undefined)).toBe("");
  });

  it("evicts one agent without touching the others, and clears everything", () => {
    const cache = new RecallCache();
    cache.resolve("agent-a", "alpha");
    cache.resolve("agent-b", "beta");

    cache.delete("agent-a");
    expect(cache.get("agent-a")).toBe("");
    expect(cache.get("agent-b")).toBe("beta");

    cache.clear();
    expect(cache.size).toBe(0);
  });
});
