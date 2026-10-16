import { describe, expect, it } from "vitest";
import {
  validateProviderDescriptor,
  type Capability,
  type ProviderAdapter,
  type ProviderHealth,
  type ProviderMetadata,
} from "@autonomous-trading-lab/provider-sdk";

class FixtureProvider implements ProviderAdapter {
  public constructor(
    private readonly id = "fixture-chain",
    private readonly advertisedCapabilities: readonly Capability[] = ["CHAIN_BLOCKS"],
  ) {}

  public providerId(): string {
    return this.id;
  }

  public capabilities(): readonly Capability[] {
    return this.advertisedCapabilities;
  }

  public async health(): Promise<ProviderHealth> {
    await Promise.resolve();
    return { status: "HEALTHY", checkedAt: "2026-01-01T00:00:00.000Z" };
  }

  public metadata(): ProviderMetadata {
    return { freshnessSeconds: 30, retryPolicy: "NONE", licenseTag: "fixture-only" };
  }
}

describe("CFIE provider contract", () => {
  it("accepts a vendor-neutral fixture provider descriptor", async () => {
    await expect(validateProviderDescriptor(new FixtureProvider())).resolves.toEqual({
      status: "HEALTHY",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("rejects unstable provider IDs and duplicate capabilities", async () => {
    expect(() => validateProviderDescriptor(new FixtureProvider("Vendor API"))).toThrow(
      /providerId/,
    );
    expect(() =>
      validateProviderDescriptor(
        new FixtureProvider("fixture-chain", ["CHAIN_BLOCKS", "CHAIN_BLOCKS"]),
      ),
    ).toThrow(/unique/);
    await Promise.resolve();
  });
});
