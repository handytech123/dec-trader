import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import {
  binanceArchiveUrls,
  downloadBinanceArchive,
  normalizeBinanceTradeCsv,
  type BinanceArchiveRequest,
} from "../src/index.js";
import { createHash } from "node:crypto";

const request: BinanceArchiveRequest = {
  symbol: "SOLUSDT",
  kind: "trades",
  interval: "daily",
  period: "2026-09-30",
};

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

describe("Binance Vision historical market adapter", () => {
  it("builds official archive and checksum URLs", () => {
    expect(binanceArchiveUrls(request)).toEqual({
      archiveUrl:
        "https://data.binance.vision/data/spot/daily/trades/SOLUSDT/SOLUSDT-trades-2026-09-30.zip",
      checksumUrl:
        "https://data.binance.vision/data/spot/daily/trades/SOLUSDT/SOLUSDT-trades-2026-09-30.zip.CHECKSUM",
    });
    expect(() => binanceArchiveUrls({ ...request, symbol: "../SOL" })).toThrow();
    expect(() => binanceArchiveUrls(request, "http://example.com")).toThrow(/HTTPS/);
  });

  it("verifies, extracts, and normalizes downloaded trade archives", async () => {
    const csv = "1,145.25000000,2.50000000,363.12500000,1790726400123456,true,true\n";
    const archive = zipSync({ "SOLUSDT-trades-2026-09-30.csv": strToU8(csv) });
    const checksum = createHash("sha256").update(archive).digest("hex");
    const artifact = await downloadBinanceArchive(
      request,
      { maximumArchiveBytes: 10_000, timeoutMs: 1000 },
      (input) => {
        const url = requestUrl(input);
        return Promise.resolve(
          url.endsWith(".CHECKSUM")
            ? new Response(`${checksum}  archive.zip\n`, { status: 200 })
            : new Response(archive, { status: 200 }),
        );
      },
    );
    expect(artifact.archiveSha256).toBe(`sha256:${checksum}`);
    expect(
      normalizeBinanceTradeCsv(artifact.csv, request, "2026-10-02T12:00:00.000Z"),
    ).toMatchObject([
      {
        eventTime: "2026-09-30T00:00:00.123Z",
        source: "binance-vision-trades",
        venue: "binance-spot",
        eventType: "TRADE",
        price: "145.25000000",
        quantity: "2.50000000",
        side: "SELL",
        bookSequence: "1",
      },
    ]);
  });

  it("rejects corrupt archives and malformed rows", async () => {
    await expect(
      downloadBinanceArchive(request, { maximumArchiveBytes: 10_000, timeoutMs: 1000 }, (input) =>
        Promise.resolve(
          requestUrl(input).endsWith(".CHECKSUM")
            ? new Response(`${"0".repeat(64)} archive.zip`)
            : new Response(zipSync({ "x.csv": strToU8("bad") })),
        ),
      ),
    ).rejects.toThrow(/mismatch/);
    expect(() => normalizeBinanceTradeCsv("1,2,3\n", request, "2026-10-02T12:00:00.000Z")).toThrow(
      /column/,
    );
  });

  it("accepts the title-case boolean format used by Vision archives", () => {
    const aggregateRequest: BinanceArchiveRequest = { ...request, kind: "aggTrades" };
    const [event] = normalizeBinanceTradeCsv(
      "9,145.00,1.25,10,11,1735689600707766,True,True\n",
      aggregateRequest,
      "2026-10-02T12:00:00.000Z",
    );
    expect(event?.side).toBe("SELL");
  });
});
