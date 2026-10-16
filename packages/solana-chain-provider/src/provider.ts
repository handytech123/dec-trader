import { z } from "zod";
import type {
  ChainProvider,
  ProviderHealth,
  ProviderMetadata,
  RawBlock,
  RawTransfer,
  Subscription,
} from "@autonomous-trading-lab/provider-sdk";

const SlotSchema = z.number().int().nonnegative();
const BlockSchema = z
  .object({
    blockHeight: z.number().int().nonnegative().nullable(),
    blockTime: z.number().int().nullable(),
    blockhash: z.string().min(1),
    parentSlot: SlotSchema,
    previousBlockhash: z.string().min(1),
    transactions: z.array(z.unknown()),
    signatures: z.array(z.string()).optional(),
    rewards: z.array(z.unknown()).optional(),
    numRewardPartitions: z.number().int().nonnegative().nullable().optional(),
  })
  .loose();

export interface JsonRpcTransport {
  request(method: string, parameters: readonly unknown[]): Promise<unknown>;
}

export class HttpJsonRpcTransport implements JsonRpcTransport {
  #requestGate: Promise<void> = Promise.resolve();
  #nextRequestAt = 0;

  public constructor(
    private readonly endpoint: string,
    private readonly timeoutMs = 20_000,
    private readonly minimumRequestIntervalMs = 0,
  ) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
      throw new Error("RPC endpoint must use HTTPS unless it is local");
    if (
      !Number.isInteger(minimumRequestIntervalMs) ||
      minimumRequestIntervalMs < 0 ||
      minimumRequestIntervalMs > 60_000
    )
      throw new Error("minimum request interval must be between 0 and 60000 milliseconds");
  }

  async #execute(method: string, parameters: readonly unknown[]): Promise<unknown> {
    const waitMs = Math.max(0, this.#nextRequestAt - Date.now());
    if (waitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
    this.#nextRequestAt = Date.now() + this.minimumRequestIntervalMs;
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: parameters }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Solana RPC HTTP ${String(response.status)}`);
    const envelope = z
      .object({ result: z.unknown().optional(), error: z.unknown().optional() })
      .loose()
      .parse(await response.json());
    if (envelope.error !== undefined) {
      const rpcError = z
        .object({ code: z.number(), message: z.string() })
        .loose()
        .safeParse(envelope.error);
      const detail = rpcError.success
        ? `${String(rpcError.data.code)} ${rpcError.data.message}`
        : "unknown RPC error";
      throw new Error(`Solana RPC ${method} returned an error: ${detail}`);
    }
    return envelope.result;
  }

  public request(method: string, parameters: readonly unknown[]): Promise<unknown> {
    const execution = this.#requestGate.then(() => this.#execute(method, parameters));
    this.#requestGate = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }
}

export class SolanaChainProvider implements ChainProvider {
  public constructor(private readonly transport: JsonRpcTransport) {}

  public providerId(): string {
    return "solana-rpc";
  }

  public capabilities(): readonly ["CHAIN_BLOCKS"] {
    return ["CHAIN_BLOCKS"];
  }

  public metadata(): ProviderMetadata {
    return { freshnessSeconds: 30, retryPolicy: "BOUNDED_EXPONENTIAL" };
  }

  public async health(): Promise<ProviderHealth> {
    try {
      await this.latestFinalizedSlot();
      return { status: "HEALTHY", checkedAt: new Date().toISOString() };
    } catch (error: unknown) {
      return {
        status: "UNAVAILABLE",
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async latestFinalizedSlot(): Promise<number> {
    return SlotSchema.parse(await this.transport.request("getSlot", [{ commitment: "finalized" }]));
  }

  public async confirmedBlockSlots(startSlot: number, endSlot: number): Promise<readonly number[]> {
    if (endSlot < startSlot) return [];
    if (endSlot - startSlot > 500_000)
      throw new Error("Solana getBlocks range exceeds 500000 slots");
    return z
      .array(SlotSchema)
      .parse(
        await this.transport.request("getBlocks", [
          startSlot,
          endSlot,
          { commitment: "finalized" },
        ]),
      );
  }

  public async getBlock(reference: string): Promise<RawBlock> {
    if (!/^(0|[1-9][0-9]*)$/.test(reference)) throw new Error("block reference must be a slot");
    const slot = Number(reference);
    if (!Number.isSafeInteger(slot)) throw new Error("slot exceeds safe integer range");
    const payload = BlockSchema.nullable().parse(
      await this.transport.request("getBlock", [
        slot,
        {
          commitment: "finalized",
          encoding: "jsonParsed",
          transactionDetails: "full",
          maxSupportedTransactionVersion: 1,
          rewards: false,
        },
      ]),
    );
    if (payload === null) throw new Error(`finalized block unavailable for slot ${reference}`);
    return {
      providerRef: `solana:slot:${reference}:${payload.blockhash}`,
      chain: "solana",
      sequence: reference,
      sourceTimestamp:
        payload.blockTime === null
          ? new Date(0).toISOString()
          : new Date(payload.blockTime * 1000).toISOString(),
      payload,
    };
  }

  public getTransfers(): Promise<readonly RawTransfer[]> {
    return Promise.reject(new Error("CHAIN_TRANSFERS capability begins in Phase 1.2"));
  }

  public streamEvents(): Promise<Subscription> {
    return Promise.reject(new Error("use the checkpointed finalized-block collector"));
  }
}
