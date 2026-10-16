import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RawBlock } from "@autonomous-trading-lab/provider-sdk";
import {
  FinalizedBlockCollector,
  MemoryChainCheckpointStore,
  SolanaChainProvider,
  type JsonRpcTransport,
} from "../src/index.js";

const fixturePath = new URL("../fixtures/get-block-101.json", import.meta.url);

class FixtureTransport implements JsonRpcTransport {
  public failuresRemaining = 0;
  public constructor(private readonly block: unknown) {}

  public request(method: string, parameters: readonly unknown[]): Promise<unknown> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return Promise.reject(new Error("synthetic disconnect"));
    }
    if (method === "getSlot") return Promise.resolve(103);
    if (method === "getBlocks") return Promise.resolve([101, 103]);
    if (method === "getBlock") {
      const slot = parameters[0];
      return Promise.resolve({
        ...(this.block as Record<string, unknown>),
        blockhash: `hash-${String(slot)}`,
      });
    }
    return Promise.reject(new Error(`unexpected method ${method}`));
  }
}

describe("Solana finalized block collector", () => {
  it("records checkpoints and explicit skipped-slot gaps from official-shape fixtures", async () => {
    // Test-local URL is a constant under the package fixture directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
    const transport = new FixtureTransport(fixture);
    const provider = new SolanaChainProvider(transport);
    const checkpoints = new MemoryChainCheckpointStore();
    const blocks: RawBlock[] = [];
    const collector = new FinalizedBlockCollector(
      provider,
      checkpoints,
      {
        append: (block) => {
          blocks.push(block);
          return Promise.resolve();
        },
      },
      101,
    );
    const result = await collector.pollOnce("2026-01-01T00:00:05.000Z");
    expect(result).toEqual(expect.objectContaining({ fromSlot: 101, toSlot: 103, blocks: 2 }));
    expect(blocks.map((block) => block.sequence)).toEqual(["101", "103"]);
    expect(checkpoints.checkpoint?.lastFinalizedSlot).toBe(103);
    expect(checkpoints.gaps).toEqual([
      expect.objectContaining({ startSlot: 102, endSlot: 102, reason: "SKIPPED_OR_UNAVAILABLE" }),
    ]);
  });

  it("does not advance the checkpoint on disconnect and resumes on the next poll", async () => {
    // Test-local URL is a constant under the package fixture directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
    const transport = new FixtureTransport(fixture);
    transport.failuresRemaining = 1;
    const checkpoints = new MemoryChainCheckpointStore();
    const collector = new FinalizedBlockCollector(
      new SolanaChainProvider(transport),
      checkpoints,
      { append: () => Promise.resolve() },
      101,
    );
    await expect(collector.pollOnce()).rejects.toThrow("disconnect");
    expect(checkpoints.checkpoint).toBeUndefined();
    await expect(collector.pollOnce()).resolves.toEqual(expect.objectContaining({ toSlot: 103 }));
    expect(checkpoints.checkpoint?.lastFinalizedSlot).toBe(103);
  });

  it("bounds parallel block retrieval and checkpoints only after all writes settle", async () => {
    let active = 0;
    let peak = 0;
    const appended: string[] = [];
    const provider = {
      providerId: () => "parallel-fixture",
      latestFinalizedSlot: () => Promise.resolve(108),
      confirmedBlockSlots: () => Promise.resolve([101, 102, 103, 104, 105, 106, 107, 108]),
      getBlock: async (slot: string): Promise<RawBlock> => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {
          providerRef: `block:${slot}`,
          chain: "solana",
          sequence: slot,
          sourceTimestamp: "2026-01-01T00:00:00.000Z",
          payload: { transactions: [] },
        };
      },
    };
    const checkpoints = new MemoryChainCheckpointStore();
    const collector = new FinalizedBlockCollector(
      provider,
      checkpoints,
      {
        append: (block) => {
          appended.push(block.sequence);
          return Promise.resolve();
        },
      },
      101,
      8,
      3,
    );
    await expect(collector.pollOnce()).resolves.toMatchObject({ blocks: 8, toSlot: 108 });
    expect(peak).toBe(3);
    expect(appended).toHaveLength(8);
    expect(checkpoints.checkpoint?.lastFinalizedSlot).toBe(108);
  });

  it("uses one ordered batch write when the sink supports it", async () => {
    const batches: string[][] = [];
    const checkpoints = new MemoryChainCheckpointStore();
    const collector = new FinalizedBlockCollector(
      {
        providerId: () => "batch-fixture",
        latestFinalizedSlot: () => Promise.resolve(103),
        confirmedBlockSlots: () => Promise.resolve([101, 102, 103]),
        getBlock: (slot: string) =>
          Promise.resolve({
            providerRef: `block:${slot}`,
            chain: "solana",
            sequence: slot,
            sourceTimestamp: "2026-01-01T00:00:00.000Z",
            payload: { transactions: [] },
          }),
      },
      checkpoints,
      {
        append: () => Promise.reject(new Error("single write should not be used")),
        appendMany: (blocks) => {
          batches.push(blocks.map((block) => block.sequence));
          return Promise.resolve();
        },
      },
      101,
      3,
      3,
    );
    await expect(collector.pollOnce()).resolves.toMatchObject({ blocks: 3, toSlot: 103 });
    expect(batches).toEqual([["101", "102", "103"]]);
    expect(checkpoints.checkpoint?.lastFinalizedSlot).toBe(103);
  });

  it("waits for parallel writes and withholds the checkpoint when one fails", async () => {
    const completed: string[] = [];
    const checkpoints = new MemoryChainCheckpointStore();
    const collector = new FinalizedBlockCollector(
      {
        providerId: () => "parallel-failure",
        latestFinalizedSlot: () => Promise.resolve(103),
        confirmedBlockSlots: () => Promise.resolve([101, 102, 103]),
        getBlock: (slot: string) =>
          Promise.resolve({
            providerRef: `block:${slot}`,
            chain: "solana",
            sequence: slot,
            sourceTimestamp: "2026-01-01T00:00:00.000Z",
            payload: { transactions: [] },
          }),
      },
      checkpoints,
      {
        append: async (block) => {
          await new Promise((resolve) => setTimeout(resolve, block.sequence === "103" ? 10 : 1));
          if (block.sequence === "102") throw new Error("synthetic write failure");
          completed.push(block.sequence);
        },
      },
      101,
      3,
      3,
    );
    await expect(collector.pollOnce()).rejects.toThrow("synthetic write failure");
    expect(completed.sort()).toEqual(["101", "103"]);
    expect(checkpoints.checkpoint).toBeUndefined();
  });

  it("fast-forwards a stale live checkpoint and captures the current finalized block", async () => {
    const checkpoints = new MemoryChainCheckpointStore();
    await checkpoints.save({
      providerId: "live-tail-fixture",
      chain: "solana",
      lastFinalizedSlot: 100,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const fetched: string[] = [];
    const collector = new FinalizedBlockCollector(
      {
        providerId: () => "live-tail-fixture",
        latestFinalizedSlot: () => Promise.resolve(1000),
        confirmedBlockSlots: (startSlot, endSlot) =>
          Promise.resolve(startSlot === 1000 && endSlot === 1000 ? [1000] : []),
        getBlock: (slot: string) => {
          fetched.push(slot);
          return Promise.resolve({
            providerRef: `block:${slot}`,
            chain: "solana",
            sequence: slot,
            sourceTimestamp: "2026-01-01T00:00:00.000Z",
            payload: { transactions: [] },
          });
        },
      },
      checkpoints,
      { append: () => Promise.resolve() },
      101,
      1,
      1,
      100,
    );

    await expect(collector.pollOnce("2026-01-01T00:01:00.000Z")).resolves.toMatchObject({
      fromSlot: 1000,
      toSlot: 1000,
      blocks: 1,
    });
    expect(fetched).toEqual(["1000"]);
    expect(checkpoints.gaps).toContainEqual(
      expect.objectContaining({
        startSlot: 101,
        endSlot: 999,
        reason: "LIVE_TAIL_FAST_FORWARD",
      }),
    );
    expect(checkpoints.checkpoint?.lastFinalizedSlot).toBe(1000);
  });

  it("rejects invalid slots and unavailable finalized blocks", async () => {
    const provider = new SolanaChainProvider({ request: () => Promise.resolve(null) });
    await expect(provider.getBlock("bad-slot")).rejects.toThrow(/slot/);
    await expect(provider.getBlock("1")).rejects.toThrow(/unavailable/);
  });
});
