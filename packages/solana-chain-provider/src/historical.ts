import { z } from "zod";
import type { JsonRpcTransport } from "./provider.js";

const AddressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const HistoricalPageSchema = z
  .object({
    data: z.array(z.unknown()),
    paginationToken: z.string().min(1).nullish(),
  })
  .strict();

export interface HistoricalAddressQuery {
  readonly address: string;
  readonly limit: number;
  readonly paginationToken?: string;
  readonly startTime?: number;
  readonly endTime?: number;
  readonly includeTokenAccounts?: "none" | "balanceChanged" | "all";
}

export interface HistoricalAddressPage {
  readonly transactions: readonly unknown[];
  readonly paginationToken?: string;
}

export class HeliusHistoricalAddressSource {
  public constructor(private readonly transport: JsonRpcTransport) {}

  public async fetchPage(query: HistoricalAddressQuery): Promise<HistoricalAddressPage> {
    const address = AddressSchema.parse(query.address);
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 1000)
      throw new Error("historical transaction limit must be between 1 and 1000");
    if (
      query.startTime !== undefined &&
      (!Number.isInteger(query.startTime) || query.startTime < 0)
    )
      throw new Error("historical start time must be a non-negative integer");
    if (query.endTime !== undefined && (!Number.isInteger(query.endTime) || query.endTime < 0))
      throw new Error("historical end time must be a non-negative integer");
    if (
      query.startTime !== undefined &&
      query.endTime !== undefined &&
      query.endTime < query.startTime
    )
      throw new Error("historical time range is reversed");
    const page = HistoricalPageSchema.parse(
      await this.transport.request("getTransactionsForAddress", [
        address,
        {
          transactionDetails: "full",
          sortOrder: "asc",
          limit: query.limit,
          filters: {
            tokenAccounts: query.includeTokenAccounts ?? "balanceChanged",
            ...(query.startTime === undefined && query.endTime === undefined
              ? {}
              : {
                  blockTime: {
                    ...(query.startTime === undefined ? {} : { gte: query.startTime }),
                    ...(query.endTime === undefined ? {} : { lte: query.endTime }),
                  },
                }),
            status: "succeeded",
          },
          ...(query.paginationToken === undefined
            ? {}
            : { paginationToken: query.paginationToken }),
        },
      ]),
    );
    return {
      transactions: page.data,
      ...(page.paginationToken == null ? {} : { paginationToken: page.paginationToken }),
    };
  }
}
