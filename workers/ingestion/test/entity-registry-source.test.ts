import { describe, expect, it, vi } from "vitest";
import { fetchVerifiedEntityRegistry } from "../src/entity-registry-source.js";

const address = "11111111111111111111111111111111";
const fixtureSource = {
  sourceId: "fixture-official-source",
  sourceUrl: "https://example.com/registry",
  records: [{ address, entityType: "PROTOCOL" as const, label: "System Program" }],
};
const manifest = {
  manifestVersion: "1" as const,
  sources: [fixtureSource],
};

describe("entity registry source connector", () => {
  it("binds records to the exact downloaded evidence", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(`Official address: ${address}`, { status: 200 }));
    const result = await fetchVerifiedEntityRegistry({
      manifest,
      retrievedAt: "2026-10-03T12:00:00.000Z",
      fetchImplementation,
    });
    expect(result.sourcesFetched).toBe(1);
    expect(result.records[0]).toMatchObject({
      address,
      validFrom: "2026-10-03T12:00:00.000Z",
      retrievedAt: "2026-10-03T12:00:00.000Z",
    });
    expect(result.records[0]?.evidenceHash).toMatch(/^sha256:/);
    expect(result.sourceSnapshots[0]).toMatchObject({
      sourceId: "fixture-official-source",
    });
    expect(typeof result.sourceSnapshots[0]?.byteCount).toBe("number");
    expect(result.sourceSnapshots[0]?.body).toContain(address);
  });

  it("rejects claims absent from their cited source", async () => {
    await expect(
      fetchVerifiedEntityRegistry({
        manifest,
        retrievedAt: "2026-10-03T12:00:00.000Z",
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(new Response("not present")),
      }),
    ).rejects.toThrow(/does not contain/);
  });

  it("rejects insecure, oversized, and failed sources", async () => {
    await expect(
      fetchVerifiedEntityRegistry({
        manifest: {
          ...manifest,
          sources: [{ ...fixtureSource, sourceUrl: "http://example.com/registry" }],
        },
        retrievedAt: "2026-10-03T12:00:00.000Z",
      }),
    ).rejects.toThrow(/HTTPS/);
    await expect(
      fetchVerifiedEntityRegistry({
        manifest,
        retrievedAt: "2026-10-03T12:00:00.000Z",
        maximumSourceBytes: 2,
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(new Response(address)),
      }),
    ).rejects.toThrow(/byte limit/);
    await expect(
      fetchVerifiedEntityRegistry({
        manifest,
        retrievedAt: "2026-10-03T12:00:00.000Z",
        fetchImplementation: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("", { status: 503 })),
      }),
    ).rejects.toThrow(/HTTP 503/);
  });
});
