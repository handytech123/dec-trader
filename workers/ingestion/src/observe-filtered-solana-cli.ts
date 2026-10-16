import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseFilteredTransaction,
  transactionSubscribeRequest,
} from "@autonomous-trading-lab/solana-chain-provider";
import { ResearchDatabase } from "./database.js";
import { databaseLocation } from "./database-location.js";
import { CORE_SOLANA_PROGRAMS, filteredAccountIncludes } from "./filtered-stream-config.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(option(name) ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}`);
  return value;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--enable-read-only-filtered-stream"))
    throw new Error(
      "filtered observation is disabled; pass --enable-read-only-filtered-stream explicitly",
    );
  const endpoint = option("--websocket-endpoint") ?? process.env.CFIE_SOLANA_WEBSOCKET_URL;
  if (!endpoint) throw new Error("a WebSocket endpoint is required");
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== "wss:") throw new Error("filtered stream endpoint must use WSS");
  const durationSeconds = boundedInteger("--max-duration-seconds", 900, 1, 3600);
  const maximumMessages = boundedInteger("--max-messages", 100_000, 1, 1_000_000);
  const maximumBytes = boundedInteger("--max-bytes", 250_000_000, 1_000_000, 1_000_000_000);
  const maximumReconnects = boundedInteger("--max-reconnects", 10, 0, 100);
  const filterId = option("--filter-id") ?? "solana-core-programs-v1";
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const entityManifestPath = option("--entity-manifest");
  const accountInclude = entityManifestPath
    ? filteredAccountIncludes(
        // This is an operator-supplied local manifest path; records are schema and address validated.
        JSON.parse(
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          await readFile(resolve(invocationDirectory, entityManifestPath), "utf8"),
        ) as unknown,
        process.argv.includes("--include-core-programs"),
      )
    : CORE_SOLANA_PROGRAMS;
  const databasePath = databaseLocation(
    invocationDirectory,
    process.env.CFIE_DATABASE_URL ?? requiredOption("--database"),
  );
  const database = new ResearchDatabase(databasePath);
  await database.migrate(
    fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url)),
  );

  let accepted = 0;
  let inserted = 0;
  let highestSlot: string | undefined;
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + durationSeconds * 1000;
  let reconnectCount = 0;
  let acknowledgedConnections = 0;
  const byteBudget = { receivedBytes: 0, limitReached: false };

  try {
    while (Date.now() < deadline && accepted < maximumMessages) {
      let writeQueue = Promise.resolve();
      let terminalError: Error | undefined;
      let subscriptionAccepted = false;
      const connectedAt = new Date().toISOString();
      const socket = new WebSocket(endpointUrl);
      const closeSocket = (code: number, reason: string): void => {
        if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
      };
      const remainingMs = Math.max(1, deadline - Date.now());
      const timeout = setTimeout(() => {
        closeSocket(1000, "bounded observation complete");
      }, remainingMs);
      try {
        await new Promise<void>((resolveSocket, rejectSocket) => {
          socket.addEventListener("open", () => {
            socket.send(JSON.stringify(transactionSubscribeRequest({ filterId, accountInclude })));
          });
          socket.addEventListener("message", (event) => {
            let payload: unknown;
            try {
              const rawMessage = String(event.data);
              const messageBytes = Buffer.byteLength(rawMessage, "utf8");
              if (byteBudget.receivedBytes + messageBytes > maximumBytes) {
                byteBudget.limitReached = true;
                closeSocket(1000, "byte limit reached");
                return;
              }
              byteBudget.receivedBytes += messageBytes;
              payload = JSON.parse(rawMessage) as unknown;
              if (typeof payload !== "object" || payload === null) return;
              if ("error" in payload) throw new Error("filtered subscription was rejected");
              if ("result" in payload && "id" in payload) {
                subscriptionAccepted = true;
                acknowledgedConnections += 1;
                return;
              }
              if (!("method" in payload)) return;
              if (!subscriptionAccepted)
                throw new Error("notification arrived before subscription acknowledgement");
              if (accepted >= maximumMessages) return;
              accepted += 1;
              if (accepted >= maximumMessages) closeSocket(1000, "message limit reached");
            } catch (error: unknown) {
              terminalError = error instanceof Error ? error : new Error(String(error));
              closeSocket(4001, "capture failure");
              return;
            }
            writeQueue = writeQueue
              .then(async () => {
                const record = parseFilteredTransaction(payload, {
                  providerId: "helius-enhanced-websocket",
                  filterId,
                  receivedAt: new Date().toISOString(),
                });
                if (await database.persistFilteredTransaction(record)) inserted += 1;
                highestSlot = record.slot;
                await database.upsertFilteredStreamCheckpoint({
                  providerId: record.providerId,
                  filterId,
                  highestReceivedSlot: highestSlot,
                  reconnectCount,
                  lastConnectedAt: connectedAt,
                  updatedAt: record.receivedAt,
                });
              })
              .catch((error: unknown) => {
                terminalError = error instanceof Error ? error : new Error(String(error));
                closeSocket(4001, "capture failure");
              });
          });
          socket.addEventListener(
            "error",
            () => {
              rejectSocket(new Error("filtered WebSocket connection failed"));
            },
            { once: true },
          );
          socket.addEventListener(
            "close",
            () => {
              resolveSocket();
            },
            { once: true },
          );
        });
        await writeQueue;
        if (terminalError) throw terminalError;
      } finally {
        clearTimeout(timeout);
      }
      if (Date.now() >= deadline || accepted >= maximumMessages) break;
      if (byteBudget.limitReached) break;
      if (reconnectCount >= maximumReconnects)
        throw new Error("filtered WebSocket reconnect limit exhausted");
      reconnectCount += 1;
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, Math.min(30_000, 1000 * 2 ** (reconnectCount - 1))),
      );
    }
    if (acknowledgedConnections === 0)
      throw new Error("filtered subscription ended without provider acknowledgement");
    process.stdout.write(
      `${JSON.stringify({ mode: "READ_ONLY_FILTERED_OBSERVATION", filterId, startedAt, completedAt: new Date().toISOString(), accountIncludeCount: accountInclude.length, acknowledgedConnections, accepted, inserted, receivedBytes: byteBudget.receivedBytes, byteLimitReached: byteBudget.limitReached, highestSlot, reconnectCount })}\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
