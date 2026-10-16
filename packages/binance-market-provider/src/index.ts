import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { unzipSync } from "fflate";
import { z } from "zod";
import { MarketEventSchema, type MarketEvent } from "@autonomous-trading-lab/capital-flow";
import { contentHash, deterministicDomainId } from "@autonomous-trading-lab/domain";

const SymbolSchema = z.string().regex(/^[A-Z0-9]{5,20}$/);
const DateSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-([012]\d|3[01])$/);
const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
// Decimal text is length-bounded by the downloaded archive and the canonical event schema.
// eslint-disable-next-line security/detect-unsafe-regex
const DecimalTextSchema = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
const IntegerTextSchema = z.string().regex(/^\d+$/);

export type BinanceArchiveKind = "trades" | "aggTrades";
export type BinanceArchiveInterval = "daily" | "monthly";

export interface BinanceArchiveRequest {
  readonly symbol: string;
  readonly kind: BinanceArchiveKind;
  readonly interval: BinanceArchiveInterval;
  readonly period: string;
}

export interface BinanceArchiveArtifact {
  readonly request: BinanceArchiveRequest;
  readonly archiveUrl: string;
  readonly checksumUrl: string;
  readonly archiveSha256: `sha256:${string}`;
  readonly csvName: string;
  readonly csv: string;
}

export interface BinanceDownloadOptions {
  readonly endpoint?: string;
  readonly maximumArchiveBytes: number;
  readonly timeoutMs: number;
}

export interface BinancePublicConnection {
  messages(): AsyncIterable<unknown>;
  close(): Promise<void>;
}

export interface BinancePublicSocket {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { readonly data?: unknown }) => void,
    options?: { readonly once?: boolean },
  ): void;
}

export type BinancePublicSocketConstructor = new (url: string) => BinancePublicSocket;

const BinanceEnvelopeSchema = z.object({ stream: z.string(), data: z.unknown() }).strict();

class BinanceSocketConnection implements BinancePublicConnection {
  readonly #queue: unknown[] = [];
  readonly #waiters: (() => void)[] = [];
  #ended = false;
  #failure: Error | undefined;

  public constructor(private readonly socket: BinancePublicSocket) {
    socket.addEventListener("message", (event) => {
      try {
        if (typeof event.data !== "string") throw new Error("expected a text WebSocket message");
        this.#queue.push(BinanceEnvelopeSchema.parse(JSON.parse(event.data)).data);
      } catch (error: unknown) {
        this.#failure = error instanceof Error ? error : new Error(String(error));
        this.#ended = true;
      }
      this.#wake();
    });
    socket.addEventListener("error", () => {
      this.#failure = new Error("Binance public WebSocket failed");
      this.#ended = true;
      this.#wake();
    });
    socket.addEventListener("close", () => {
      this.#ended = true;
      this.#wake();
    });
  }

  #wake(): void {
    for (const resolveWaiter of this.#waiters.splice(0)) resolveWaiter();
  }

  public async *messages(): AsyncIterable<unknown> {
    while (!this.#ended || this.#queue.length > 0) {
      const message = this.#queue.shift();
      if (message !== undefined) {
        yield message;
        continue;
      }
      if (this.#failure) throw this.#failure;
      await new Promise<void>((resolveWaiter) => this.#waiters.push(resolveWaiter));
    }
    if (this.#failure) throw this.#failure;
  }

  public close(): Promise<void> {
    this.#ended = true;
    if (this.socket.readyState < 2) this.socket.close(1000, "bounded observation complete");
    this.#wake();
    return Promise.resolve();
  }
}

export class BinancePublicWebSocketFactory {
  readonly #url: string;
  readonly #connectionTimeoutMs: number;

  public constructor(
    candidate: {
      readonly endpoint: string;
      readonly symbol: string;
      readonly connectionTimeoutMs: number;
    },
    private readonly Socket: BinancePublicSocketConstructor = WebSocket,
  ) {
    const endpoint = new URL(candidate.endpoint);
    if (endpoint.protocol !== "wss:") throw new Error("Binance stream endpoint must use WSS");
    const symbol = SymbolSchema.parse(candidate.symbol).toLowerCase();
    if (
      !Number.isInteger(candidate.connectionTimeoutMs) ||
      candidate.connectionTimeoutMs < 1000 ||
      candidate.connectionTimeoutMs > 30_000
    )
      throw new Error("connectionTimeoutMs must be between 1000 and 30000");
    endpoint.pathname = "/stream";
    endpoint.search = new URLSearchParams({
      streams: `${symbol}@aggTrade/${symbol}@depth@100ms`,
    }).toString();
    this.#url = endpoint.toString();
    this.#connectionTimeoutMs = candidate.connectionTimeoutMs;
  }

  public async connect(): Promise<BinancePublicConnection> {
    const socket = new this.Socket(this.#url);
    const connection = new BinanceSocketConnection(socket);
    await new Promise<void>((resolveConnection, reject) => {
      const timeout = setTimeout(() => {
        socket.close(1000, "connection timeout");
        reject(new Error("Binance public WebSocket connection timed out"));
      }, this.#connectionTimeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolveConnection();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("Binance public WebSocket connection failed"));
        },
        { once: true },
      );
    });
    return connection;
  }
}

const BinanceDepthSnapshotSchema = z
  .object({
    lastUpdateId: z.number().int().nonnegative(),
    bids: z.array(z.tuple([DecimalTextSchema, DecimalTextSchema])),
    asks: z.array(z.tuple([DecimalTextSchema, DecimalTextSchema])),
  })
  .loose();

export type BinanceDepthSnapshot = z.infer<typeof BinanceDepthSnapshotSchema>;

export class BinancePublicRestDepthSource {
  readonly #endpoint: URL;
  readonly #timeoutMs: number;

  public constructor(
    candidate: { readonly endpoint: string; readonly timeoutMs: number },
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.#endpoint = new URL(candidate.endpoint);
    if (this.#endpoint.protocol !== "https:")
      throw new Error("Binance REST endpoint must use HTTPS");
    if (
      !Number.isInteger(candidate.timeoutMs) ||
      candidate.timeoutMs < 1000 ||
      candidate.timeoutMs > 30_000
    )
      throw new Error("timeoutMs must be between 1000 and 30000");
    this.#timeoutMs = candidate.timeoutMs;
  }

  public async snapshot(symbolCandidate: string): Promise<BinanceDepthSnapshot> {
    const symbol = SymbolSchema.parse(symbolCandidate);
    const url = new URL("api/v3/depth", this.#endpoint);
    url.search = new URLSearchParams({ symbol, limit: "1000" }).toString();
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(this.#timeoutMs) });
    if (!response.ok)
      throw new Error(`Binance depth request failed with HTTP ${String(response.status)}`);
    return BinanceDepthSnapshotSchema.parse(await response.json());
  }

  public async aggregateTrades(
    symbolCandidate: string,
    fromId: number,
    toId: number,
    maximumTrades: number,
  ): Promise<readonly unknown[]> {
    const symbol = SymbolSchema.parse(symbolCandidate);
    if (!Number.isSafeInteger(fromId) || !Number.isSafeInteger(toId) || toId < fromId)
      throw new Error("invalid Binance aggregate-trade range");
    const count = toId - fromId + 1;
    if (!Number.isInteger(maximumTrades) || maximumTrades < 1 || maximumTrades > 1000)
      throw new Error("maximumTrades must be between 1 and 1000");
    if (count > maximumTrades) throw new Error("Binance aggregate-trade gap exceeds the limit");
    const url = new URL("api/v3/aggTrades", this.#endpoint);
    url.search = new URLSearchParams({
      symbol,
      fromId: String(fromId),
      limit: String(count),
    }).toString();
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(this.#timeoutMs) });
    if (!response.ok)
      throw new Error(
        `Binance aggregate-trade request failed with HTTP ${String(response.status)}`,
      );
    const trades = z.array(BinanceRestAggregateTradeSchema).parse(await response.json());
    if (trades.length !== count) throw new Error("Binance aggregate-trade backfill is incomplete");
    for (const [index, trade] of trades.entries()) {
      if (trade.a !== fromId + index)
        throw new Error("Binance aggregate-trade backfill is not contiguous");
    }
    return trades.map((trade) =>
      BinanceAggregateTradeSchema.parse({
        ...trade,
        e: "aggTrade",
        E: trade.T,
        s: symbol,
      }),
    );
  }
}

const BinanceRestAggregateTradeSchema = z
  .object({
    a: z.number().int().nonnegative(),
    p: DecimalTextSchema,
    q: DecimalTextSchema,
    T: z.number().int().nonnegative(),
    m: z.boolean(),
  })
  .loose();

const BinanceAggregateTradeSchema = z
  .object({
    e: z.literal("aggTrade"),
    E: z.number().int().nonnegative(),
    s: SymbolSchema,
    a: z.number().int().nonnegative(),
    p: DecimalTextSchema,
    q: DecimalTextSchema,
    T: z.number().int().nonnegative(),
    m: z.boolean(),
  })
  .loose();

const BinanceDepthUpdateSchema = z
  .object({
    e: z.literal("depthUpdate"),
    E: z.number().int().nonnegative(),
    s: SymbolSchema,
    U: z.number().int().nonnegative(),
    u: z.number().int().nonnegative(),
    b: z.array(z.tuple([DecimalTextSchema, DecimalTextSchema])),
    a: z.array(z.tuple([DecimalTextSchema, DecimalTextSchema])),
  })
  .loose();

export function normalizeBinanceAggregateTrade(
  message: unknown,
  ingestedAt: string,
  venue = "binance-spot",
): MarketEvent {
  const trade = BinanceAggregateTradeSchema.parse(message);
  const parsedVenue = z.string().min(1).max(100).parse(venue);
  return MarketEventSchema.parse({
    eventId: deterministicDomainId(
      "event",
      `${parsedVenue}:${trade.s}:aggTrade:${String(trade.a)}`,
    ),
    eventTime: new Date(trade.T).toISOString(),
    ingestTime: ingestedAt,
    source: `${parsedVenue}-aggTrade-websocket`,
    venue: parsedVenue,
    instrumentId: deterministicDomainId("instrument", `${parsedVenue}:${trade.s}`),
    eventType: "TRADE",
    price: trade.p,
    quantity: trade.q,
    side: trade.m ? "SELL" : "BUY",
    bookSequence: String(trade.a),
    rawRef: contentHash(message),
    schemaVersion: "1",
  });
}

export interface BinanceBookView {
  readonly sequence: string;
  readonly bids: readonly { readonly price: string; readonly size: string }[];
  readonly asks: readonly { readonly price: string; readonly size: string }[];
}

export class BinanceDepthBook {
  readonly #bids = new Map<string, string>();
  readonly #asks = new Map<string, string>();
  #lastUpdateId: number;

  public constructor(snapshotCandidate: unknown) {
    const snapshot = BinanceDepthSnapshotSchema.parse(snapshotCandidate);
    this.#lastUpdateId = snapshot.lastUpdateId;
    for (const [price, size] of snapshot.bids)
      if (!new Decimal(size).isZero()) this.#bids.set(price, size);
    for (const [price, size] of snapshot.asks)
      if (!new Decimal(size).isZero()) this.#asks.set(price, size);
  }

  public apply(candidate: unknown): boolean {
    const update = BinanceDepthUpdateSchema.parse(candidate);
    if (update.u <= this.#lastUpdateId) return false;
    if (update.U > this.#lastUpdateId + 1)
      throw new Error(
        `Binance depth sequence gap: expected ${String(this.#lastUpdateId + 1)}, received ${String(update.U)}`,
      );
    for (const [price, size] of update.b) {
      if (new Decimal(size).isZero()) this.#bids.delete(price);
      else this.#bids.set(price, size);
    }
    for (const [price, size] of update.a) {
      if (new Decimal(size).isZero()) this.#asks.delete(price);
      else this.#asks.set(price, size);
    }
    this.#lastUpdateId = update.u;
    return true;
  }

  public view(maximumLevels = 1000): BinanceBookView {
    if (!Number.isInteger(maximumLevels) || maximumLevels < 1 || maximumLevels > 1000)
      throw new Error("maximumLevels must be between 1 and 1000");
    const bids = [...this.#bids].sort(([left], [right]) => Number(right) - Number(left));
    const asks = [...this.#asks].sort(([left], [right]) => Number(left) - Number(right));
    return {
      sequence: String(this.#lastUpdateId),
      bids: bids.slice(0, maximumLevels).map(([price, size]) => ({ price, size })),
      asks: asks.slice(0, maximumLevels).map(([price, size]) => ({ price, size })),
    };
  }
}

export function binanceMessageType(message: unknown): "aggTrade" | "depthUpdate" {
  return z
    .object({ e: z.enum(["aggTrade", "depthUpdate"]) })
    .loose()
    .parse(message).e;
}

export function binanceMessageMetadata(message: unknown): {
  readonly type: "aggTrade" | "depthUpdate";
  readonly symbol: string;
  readonly eventTime: string;
  readonly sequence: number;
} {
  const type = binanceMessageType(message);
  if (type === "aggTrade") {
    const trade = BinanceAggregateTradeSchema.parse(message);
    return { type, symbol: trade.s, eventTime: new Date(trade.E).toISOString(), sequence: trade.a };
  }
  const update = BinanceDepthUpdateSchema.parse(message);
  return {
    type,
    symbol: update.s,
    eventTime: new Date(update.E).toISOString(),
    sequence: update.u,
  };
}

export interface BinanceNormalizedTrade {
  readonly event: MarketEvent;
  readonly payload: {
    readonly request: BinanceArchiveRequest;
    readonly columns: readonly string[];
  };
}

function validatedRequest(candidate: BinanceArchiveRequest): BinanceArchiveRequest {
  const symbol = SymbolSchema.parse(candidate.symbol);
  const period = (candidate.interval === "daily" ? DateSchema : MonthSchema).parse(
    candidate.period,
  );
  const kind = z.enum(["trades", "aggTrades"]).parse(candidate.kind);
  const interval = z.enum(["daily", "monthly"]).parse(candidate.interval);
  return { symbol, kind, interval, period };
}

export function binanceArchiveUrls(
  candidate: BinanceArchiveRequest,
  endpoint = "https://data.binance.vision/",
): { archiveUrl: string; checksumUrl: string } {
  const request = validatedRequest(candidate);
  const base = new URL(endpoint);
  if (base.protocol !== "https:") throw new Error("Binance archive endpoint must use HTTPS");
  const filename = `${request.symbol}-${request.kind}-${request.period}.zip`;
  const path = `data/spot/${request.interval}/${request.kind}/${request.symbol}/${filename}`;
  const archiveUrl = new URL(path, base).toString();
  return { archiveUrl, checksumUrl: `${archiveUrl}.CHECKSUM` };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function boundedFetch(
  url: string,
  maximumBytes: number,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<Uint8Array> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok)
    throw new Error(`Binance archive request failed with HTTP ${String(response.status)}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes)
    throw new Error("Binance archive exceeds the configured byte limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes)
    throw new Error("Binance archive exceeds the configured byte limit");
  return bytes;
}

export async function downloadBinanceArchive(
  candidate: BinanceArchiveRequest,
  options: BinanceDownloadOptions,
  fetcher: typeof fetch = fetch,
): Promise<BinanceArchiveArtifact> {
  if (!Number.isInteger(options.maximumArchiveBytes) || options.maximumArchiveBytes < 1024)
    throw new Error("maximumArchiveBytes must be an integer of at least 1024");
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1000 ||
    options.timeoutMs > 120_000
  )
    throw new Error("timeoutMs must be between 1000 and 120000");
  const request = validatedRequest(candidate);
  const urls = binanceArchiveUrls(request, options.endpoint);
  const [archive, checksumBytes] = await Promise.all([
    boundedFetch(urls.archiveUrl, options.maximumArchiveBytes, options.timeoutMs, fetcher),
    boundedFetch(urls.checksumUrl, 1024, options.timeoutMs, fetcher),
  ]);
  const checksumText = new TextDecoder().decode(checksumBytes).trim();
  const expected = checksumText.split(/\s+/u)[0]?.toLowerCase();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error("invalid Binance checksum file");
  const actual = sha256(archive);
  if (actual !== expected) throw new Error("Binance archive checksum mismatch");
  const files = unzipSync(archive);
  const csvEntries = Object.entries(files).filter(([name]) => name.endsWith(".csv"));
  if (csvEntries.length !== 1 || !csvEntries[0])
    throw new Error("Binance archive must contain exactly one CSV file");
  const [csvName, csvBytes] = csvEntries[0];
  return {
    request,
    ...urls,
    archiveSha256: `sha256:${actual}`,
    csvName,
    csv: new TextDecoder().decode(csvBytes),
  };
}

function timestampFromEpoch(raw: string): string {
  IntegerTextSchema.parse(raw);
  const epoch = BigInt(raw);
  const milliseconds = raw.length > 13 ? epoch / 1000n : epoch;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("timestamp exceeds safe range");
  const date = new Date(Number(milliseconds));
  if (Number.isNaN(date.valueOf())) throw new Error("invalid Binance timestamp");
  return date.toISOString();
}

function rows(csv: string): string[][] {
  return csv
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.toLowerCase().startsWith("id,"))
    .map((line) => line.split(","));
}

export function parseBinanceTradeCsv(
  csv: string,
  candidate: BinanceArchiveRequest,
  ingestedAt: string,
  maximumRecords = 1_000_000,
): readonly BinanceNormalizedTrade[] {
  const request = validatedRequest(candidate);
  const parsedIngestedAt = z.iso.datetime({ offset: true }).parse(ingestedAt);
  const expectedColumns = request.kind === "trades" ? 7 : 8;
  if (!Number.isInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 10_000_000)
    throw new Error("maximumRecords must be between 1 and 10000000");
  const parsedRows = rows(csv);
  if (parsedRows.length > maximumRecords)
    throw new Error("Binance archive exceeds the configured record limit");
  return parsedRows.map((columns) => {
    if (columns.length !== expectedColumns) throw new Error("unexpected Binance CSV column count");
    const [id, price, quantity] = columns;
    const timestamp = columns[request.kind === "trades" ? 4 : 5];
    const buyerIsMaker = columns[request.kind === "trades" ? 5 : 6];
    if (!id || !price || !quantity || !timestamp) throw new Error("incomplete Binance CSV row");
    IntegerTextSchema.parse(id);
    DecimalTextSchema.parse(price);
    DecimalTextSchema.parse(quantity);
    const normalizedMakerFlag = buyerIsMaker?.toLowerCase();
    if (normalizedMakerFlag !== "true" && normalizedMakerFlag !== "false")
      throw new Error("invalid Binance maker-side flag");
    const identity = `binance:${request.symbol}:${request.kind}:${id}`;
    const raw = { request, columns };
    const event = MarketEventSchema.parse({
      eventId: deterministicDomainId("event", identity),
      eventTime: timestampFromEpoch(timestamp),
      ingestTime: parsedIngestedAt,
      source: `binance-vision-${request.kind}`,
      venue: "binance-spot",
      instrumentId: deterministicDomainId("instrument", `binance:${request.symbol}`),
      eventType: "TRADE",
      price,
      quantity,
      side: normalizedMakerFlag === "true" ? "SELL" : "BUY",
      bookSequence: id,
      rawRef: contentHash(raw),
      schemaVersion: "1",
    });
    return { event, payload: raw };
  });
}

export function normalizeBinanceTradeCsv(
  csv: string,
  candidate: BinanceArchiveRequest,
  ingestedAt: string,
  maximumRecords = 1_000_000,
): readonly MarketEvent[] {
  return parseBinanceTradeCsv(csv, candidate, ingestedAt, maximumRecords).map(({ event }) => event);
}
