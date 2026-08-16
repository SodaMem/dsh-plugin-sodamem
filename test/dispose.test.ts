import { afterEach, describe, expect, it } from "vitest";
import { Config, apply, inject, name } from "../src/index.js";
import {
  CONFIG,
  assemble,
  claim,
  contributedText,
  createFakeContext,
  installContextFetch,
  type FetchDouble,
} from "./harness.js";

let fetchDouble: FetchDouble | undefined;

afterEach(() => {
  fetchDouble?.restore();
  fetchDouble = undefined;
});

describe("plugin surface", () => {
  it("exports the cordis plugin shape", () => {
    expect(name).toBe("sodamem");
    expect(inject).toEqual(["systemPrompt"]);
    expect(typeof Config).toBe("function");
  });

  it("Config exposes exactly the four connection/scope fields and no behaviour knob", () => {
    const dict = (Config as unknown as { dict: Record<string, unknown> }).dict;
    expect(Object.keys(dict).sort()).toEqual(["apiKey", "apiUrl", "tokenBudget", "userId"]);
  });

  it("Config defaults tokenBudget to 1200 and rejects a missing apiUrl", () => {
    const resolved = Config({ apiUrl: "http://x", apiKey: "k", userId: "u" });
    expect(resolved.tokenBudget).toBe(1200);
    expect(() => Config({ apiKey: "k", userId: "u" })).toThrow();
  });

  it("agent/disposed evicts only that agent's cached memory", async () => {
    fetchDouble = installContextFetch("remembered");
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    for (const id of ["agent-a", "agent-b"]) {
      claim(fake, id, "hello");
      await assemble(fake, id);
    }

    const disposed = fake.listeners.get("agent/disposed") as unknown as (p: unknown) => void;
    disposed({ agent: { id: "agent-a" } });

    expect(await contributedText(fake, "agent-a")).toBe("");
    expect(await contributedText(fake, "agent-b")).toBe("remembered");
  });

  it("unload disposes every registration and empties the cache", async () => {
    fetchDouble = installContextFetch("remembered");
    const fake = createFakeContext();
    apply(fake.ctx, CONFIG);

    claim(fake, "agent-a", "hello");
    expect((await assemble(fake, "agent-a")).text).toBe("remembered");

    fake.unload();

    expect(fake.disposedLabels.sort()).toEqual([
      "agent/disposed",
      "agent/inbox/claimed",
      "agent/turn-stopping",
      "system-prompt/assemble",
    ]);
    // The cache went with the registrations.
    expect(await contributedText(fake, "agent-a")).toBe("");
  });
});
