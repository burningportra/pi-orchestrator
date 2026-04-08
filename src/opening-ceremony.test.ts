import { describe, expect, it } from "vitest";

import {
  getOpeningCeremonyFrames,
  resolveOpeningCeremonyMode,
  runOpeningCeremony,
} from "./opening-ceremony.js";

describe("opening ceremony renderer", () => {
  it("returns a deterministic multi-frame ceremony sequence", () => {
    const frames = getOpeningCeremonyFrames();

    expect(frames).toHaveLength(3);
    expect(frames[0]?.text).toContain("PI // ORCHESTRATOR");
    expect(frames[1]?.text).toContain("summoning bead engine");
    expect(frames[2]?.text).toContain("ignite /orchestrate");
    expect(frames.every((frame) => frame.delayMs > 0)).toBe(true);
  });

  it("distinguishes animated, static, and skipped modes", () => {
    expect(resolveOpeningCeremonyMode()).toBe("animated");
    expect(resolveOpeningCeremonyMode({ interactive: false })).toBe("static");
    expect(resolveOpeningCeremonyMode({ reducedMotion: true })).toBe("static");
    expect(resolveOpeningCeremonyMode({ terminalWidth: 40 })).toBe("static");
    expect(resolveOpeningCeremonyMode({ enabled: false })).toBe("skip");
    expect(resolveOpeningCeremonyMode({ quiet: true })).toBe("skip");
  });

  it("caps animated runtime using the injected timer", async () => {
    const writes: string[] = [];
    const sleeps: number[] = [];
    let now = 0;

    const result = await runOpeningCeremony(
      {
        write: async (text) => {
          writes.push(text);
        },
      },
      {
        maxDurationMs: 150,
        runtime: {
          now: () => now,
          sleep: async (ms) => {
            sleeps.push(ms);
            now += ms;
          },
        },
      },
    );

    expect(result.mode).toBe("animated");
    expect(result.rendered).toBe(true);
    expect(result.frameCount).toBe(3);
    expect(result.durationMs).toBeLessThanOrEqual(150);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(150);
    expect(writes).toHaveLength(3);
  });

  it("renders a single static frame when animation degrades", async () => {
    const writes: string[] = [];

    const result = await runOpeningCeremony(
      {
        write: (text) => {
          writes.push(text);
        },
      },
      { interactive: false },
    );

    expect(result).toMatchObject({ rendered: true, mode: "static", frameCount: 1 });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("ignite /orchestrate");
  });

  it("fails open when the writer throws", async () => {
    const result = await runOpeningCeremony(
      {
        write: () => {
          throw new Error("writer exploded");
        },
      },
      {},
    );

    expect(result.rendered).toBe(false);
    expect(result.error).toContain("writer exploded");
  });

  it("fails open when the sleep path throws", async () => {
    const result = await runOpeningCeremony(
      { write: () => {} },
      {
        runtime: {
          now: () => 0,
          sleep: async () => {
            throw new Error("timer exploded");
          },
        },
      },
    );

    expect(result.rendered).toBe(false);
    expect(result.error).toContain("timer exploded");
  });
});
