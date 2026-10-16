import { describe, expect, it } from "vitest";
import { HeliusHistoricalAddressSource, type JsonRpcTransport } from "../src/index.js";

describe("Helius historical address source", () => {
  it("requests a bounded ascending, successful, token-aware page", async () => {
    const requests: { method: string; parameters: readonly unknown[] }[] = [];
    const transport: JsonRpcTransport = {
      request(method, parameters) {
        requests.push({ method, parameters });
        return Promise.resolve({ data: [{ signature: "signature-1" }], paginationToken: "next" });
      },
    };
    const source = new HeliusHistoricalAddressSource(transport);
    await expect(
      source.fetchPage({
        address: "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY",
        limit: 100,
        startTime: 1_700_000_000,
        endTime: 1_700_000_100,
      }),
    ).resolves.toEqual({ transactions: [{ signature: "signature-1" }], paginationToken: "next" });
    expect(requests).toEqual([
      {
        method: "getTransactionsForAddress",
        parameters: [
          "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY",
          {
            transactionDetails: "full",
            sortOrder: "asc",
            limit: 100,
            filters: {
              tokenAccounts: "balanceChanged",
              blockTime: { gte: 1_700_000_000, lte: 1_700_000_100 },
              status: "succeeded",
            },
          },
        ],
      },
    ]);
  });

  it("rejects invalid addresses and unbounded or reversed requests", async () => {
    const source = new HeliusHistoricalAddressSource({
      request: () => Promise.resolve({ data: [] }),
    });
    await expect(source.fetchPage({ address: "bad", limit: 1 })).rejects.toThrow();
    await expect(
      source.fetchPage({
        address: "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY",
        limit: 1001,
      }),
    ).rejects.toThrow(/between 1 and 1000/);
    await expect(
      source.fetchPage({
        address: "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY",
        limit: 1,
        startTime: 2,
        endTime: 1,
      }),
    ).rejects.toThrow(/reversed/);
  });
});
