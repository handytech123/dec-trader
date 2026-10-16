export interface PublicMarketConnection {
  messages(): AsyncIterable<unknown>;
  close(): Promise<void>;
}

export interface PublicMarketConnectionFactory {
  connect(): Promise<PublicMarketConnection>;
}

export interface ReconnectPolicy {
  readonly maximumAttempts: number;
  readonly baseDelayMs: number;
  readonly maximumDelayMs: number;
}

export interface StreamRunResult {
  readonly connections: number;
  readonly messages: number;
  readonly reconnects: number;
}

export interface ReconnectEvent {
  readonly attempt: number;
  readonly detectedAt: string;
  readonly reason: string;
}

export class BoundedMarketStream {
  public constructor(
    private readonly factory: PublicMarketConnectionFactory,
    private readonly policy: ReconnectPolicy,
    private readonly delay: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    if (!Number.isInteger(policy.maximumAttempts) || policy.maximumAttempts < 0)
      throw new Error("maximumAttempts must be a non-negative integer");
    if (policy.baseDelayMs < 0 || policy.maximumDelayMs < policy.baseDelayMs)
      throw new Error("invalid reconnect delay bounds");
  }

  public async run(
    handle: (message: unknown) => Promise<void>,
    signal: AbortSignal,
    onReconnect: (event: ReconnectEvent) => void | Promise<void>,
  ): Promise<StreamRunResult> {
    let connections = 0;
    let messages = 0;
    let reconnects = 0;
    let consecutiveFailures = 0;
    const aborted = (): boolean => signal.aborted;
    while (!aborted()) {
      let connection: PublicMarketConnection | undefined;
      let closing: Promise<void> | undefined;
      const closeConnection = (): Promise<void> => {
        if (!connection) return Promise.resolve();
        closing ??= connection.close();
        return closing;
      };
      const closeOnAbort = (): void => {
        void closeConnection();
      };
      try {
        connection = await this.factory.connect();
        signal.addEventListener("abort", closeOnAbort, { once: true });
        if (aborted()) await closeConnection();
        connections += 1;
        for await (const message of connection.messages()) {
          if (aborted()) break;
          await handle(message);
          messages += 1;
          consecutiveFailures = 0;
        }
        if (aborted()) break;
        throw new Error("public market stream ended unexpectedly");
      } catch (error: unknown) {
        if (aborted()) break;
        consecutiveFailures += 1;
        if (consecutiveFailures > this.policy.maximumAttempts) throw error;
        reconnects += 1;
        await onReconnect({
          attempt: consecutiveFailures,
          detectedAt: new Date().toISOString(),
          reason: error instanceof Error ? error.message : String(error),
        });
        const delayMs = Math.min(
          this.policy.maximumDelayMs,
          this.policy.baseDelayMs * 2 ** (consecutiveFailures - 1),
        );
        await this.delay(delayMs);
      } finally {
        signal.removeEventListener("abort", closeOnAbort);
        await closeConnection();
      }
    }
    return { connections, messages, reconnects };
  }
}
