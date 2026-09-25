import { Decimal } from "decimal.js";
import { z } from "zod";
import { AtomicQuantitySchema, IsoTimestampSchema } from "@autonomous-trading-lab/domain";

export const PaperFillModelSchema = z
  .object({
    modelVersion: z.string().min(1),
    decisionToQuoteLatencyMs: z.number().int().nonnegative(),
    quoteToSubmitLatencyMs: z.number().int().nonnegative(),
    routeFeeBps: z.number().int().nonnegative(),
    networkFeeAtomic: AtomicQuantitySchema,
    baseFailureBps: z.number().int().min(0).max(10_000),
    stressMultiplier: z
      .string()
      // Anchored canonical non-negative decimal grammar.
      // eslint-disable-next-line security/detect-unsafe-regex
      .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
  })
  .strict();
export type PaperFillModel = z.infer<typeof PaperFillModelSchema>;

export const PaperOrderSchema = z
  .object({
    orderId: z.string().min(1),
    inputAtomic: AtomicQuantitySchema,
    quotedOutputAtomic: AtomicQuantitySchema,
    availableLiquidityInputAtomic: AtomicQuantitySchema,
    priceImpactBps: z.number().int().nonnegative(),
    slippageBps: z.number().int().nonnegative(),
    decidedAt: IsoTimestampSchema,
    quoteExpiresAt: IsoTimestampSchema,
    deterministicFailureDrawBps: z.number().int().min(0).max(9_999),
  })
  .strict();
export type PaperOrder = z.infer<typeof PaperOrderSchema>;

export type PaperFill =
  | {
      status: "REJECTED";
      orderId: string;
      modelVersion: string;
      reason: "QUOTE_EXPIRED" | "NO_LIQUIDITY" | "SIMULATED_FAILURE";
    }
  | {
      status: "FILLED" | "PARTIAL";
      orderId: string;
      modelVersion: string;
      inputAtomic: string;
      outputAtomic: string;
      executionCostOutputAtomic: string;
      networkFeeAtomic: string;
      totalLatencyMs: number;
    };

const basisPoints = new Decimal(10_000);

export function simulatePaperFill(orderInput: PaperOrder, modelInput: PaperFillModel): PaperFill {
  const order = PaperOrderSchema.parse(orderInput);
  const model = PaperFillModelSchema.parse(modelInput);
  const completionTime =
    new Date(order.decidedAt).getTime() +
    model.decisionToQuoteLatencyMs +
    model.quoteToSubmitLatencyMs;
  if (completionTime > new Date(order.quoteExpiresAt).getTime())
    return {
      status: "REJECTED",
      orderId: order.orderId,
      modelVersion: model.modelVersion,
      reason: "QUOTE_EXPIRED",
    };
  if (new Decimal(order.availableLiquidityInputAtomic).isZero())
    return {
      status: "REJECTED",
      orderId: order.orderId,
      modelVersion: model.modelVersion,
      reason: "NO_LIQUIDITY",
    };
  if (order.deterministicFailureDrawBps < model.baseFailureBps)
    return {
      status: "REJECTED",
      orderId: order.orderId,
      modelVersion: model.modelVersion,
      reason: "SIMULATED_FAILURE",
    };
  const variableCostBps = new Decimal(
    order.priceImpactBps + order.slippageBps + model.routeFeeBps,
  ).mul(model.stressMultiplier);
  const requestedInput = new Decimal(order.inputAtomic);
  const filledInput = Decimal.min(requestedInput, order.availableLiquidityInputAtomic);
  const grossOutput = new Decimal(order.quotedOutputAtomic).mul(filledInput).div(requestedInput);
  const output = grossOutput.mul(basisPoints.minus(variableCostBps)).div(basisPoints).floor();
  const variableCost = grossOutput.minus(output);
  return {
    status: filledInput.lessThan(requestedInput) ? "PARTIAL" : "FILLED",
    orderId: order.orderId,
    modelVersion: model.modelVersion,
    inputAtomic: filledInput.toFixed(0),
    outputAtomic: Decimal.max(output, 0).toFixed(0),
    executionCostOutputAtomic: variableCost.toFixed(0),
    networkFeeAtomic: model.networkFeeAtomic,
    totalLatencyMs: model.decisionToQuoteLatencyMs + model.quoteToSubmitLatencyMs,
  };
}
