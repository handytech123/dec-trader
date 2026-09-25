import { contentHash } from "@autonomous-trading-lab/domain";

export const LEGACY_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export interface MintSafetyFacts {
  readonly program: "SPL_TOKEN" | "TOKEN_2022" | "UNKNOWN";
  readonly initialized: boolean;
  readonly decimals: number;
  readonly supplyAtomic: string;
  readonly mintAuthorityPresent: boolean;
  readonly freezeAuthorityPresent: boolean;
  readonly extensionBytes: number;
  readonly extensions: readonly string[];
  readonly unknownExtensionTypes: readonly number[];
}

export interface TokenSafetyAssessment {
  readonly version: 1;
  readonly status: "PASS" | "REVIEW" | "BLOCK";
  readonly reasons: readonly string[];
  readonly facts: MintSafetyFacts;
  readonly contentHash: `sha256:${string}`;
}

const view = (data: Uint8Array): DataView =>
  new DataView(data.buffer, data.byteOffset, data.byteLength);

const extensionNames = new Map<number, string>([
  [1, "TRANSFER_FEE_CONFIG"],
  [3, "MINT_CLOSE_AUTHORITY"],
  [4, "CONFIDENTIAL_TRANSFER_MINT"],
  [6, "DEFAULT_ACCOUNT_STATE"],
  [9, "NON_TRANSFERABLE"],
  [10, "INTEREST_BEARING_CONFIG"],
  [12, "PERMANENT_DELEGATE"],
  [14, "TRANSFER_HOOK"],
  [16, "CONFIDENTIAL_TRANSFER_FEE_CONFIG"],
  [18, "METADATA_POINTER"],
  [19, "TOKEN_METADATA"],
  [20, "GROUP_POINTER"],
  [21, "TOKEN_GROUP"],
  [22, "GROUP_MEMBER_POINTER"],
  [23, "TOKEN_GROUP_MEMBER"],
  [24, "CONFIDENTIAL_MINT_BURN"],
  [25, "SCALED_UI_AMOUNT_CONFIG"],
  [26, "PAUSABLE_CONFIG"],
]);

export function parseMintExtensions(data: Uint8Array): {
  readonly names: readonly string[];
  readonly unknownTypes: readonly number[];
} {
  if (data.byteLength <= 166) return { names: [], unknownTypes: [] };
  const names: string[] = [];
  const unknownTypes: number[] = [];
  let offset = 166;
  while (offset + 4 <= data.byteLength) {
    const type = view(data).getUint16(offset, true);
    const length = view(data).getUint16(offset + 2, true);
    if (type === 0 && length === 0) break;
    const end = offset + 4 + length;
    if (end > data.byteLength) throw new Error("Token-2022 extension exceeds mint account data");
    const name = extensionNames.get(type);
    if (name) names.push(name);
    else unknownTypes.push(type);
    offset = end;
  }
  return { names, unknownTypes };
}

export function inspectMintAccount(data: Uint8Array, owner: string): TokenSafetyAssessment {
  if (data.byteLength < 82) throw new Error("mint account is shorter than the SPL Mint layout");
  const program =
    owner === LEGACY_TOKEN_PROGRAM
      ? "SPL_TOKEN"
      : owner === TOKEN_2022_PROGRAM
        ? "TOKEN_2022"
        : "UNKNOWN";
  const extensions =
    program === "TOKEN_2022" ? parseMintExtensions(data) : { names: [], unknownTypes: [] };
  const facts: MintSafetyFacts = {
    program,
    initialized: data[45] === 1,
    decimals: data[44] ?? 0,
    supplyAtomic: view(data).getBigUint64(36, true).toString(),
    mintAuthorityPresent: view(data).getUint32(0, true) !== 0,
    freezeAuthorityPresent: view(data).getUint32(46, true) !== 0,
    extensionBytes: Math.max(0, data.byteLength - 82),
    extensions: extensions.names,
    unknownExtensionTypes: extensions.unknownTypes,
  };
  const reasons: string[] = [];
  if (program === "UNKNOWN") reasons.push("UNRECOGNIZED_TOKEN_PROGRAM");
  if (!facts.initialized) reasons.push("MINT_NOT_INITIALIZED");
  if (facts.freezeAuthorityPresent) reasons.push("FREEZE_AUTHORITY_ACTIVE");
  if (facts.mintAuthorityPresent) reasons.push("MINT_AUTHORITY_ACTIVE");
  const blockingExtensions = new Set([
    "NON_TRANSFERABLE",
    "PERMANENT_DELEGATE",
    "TRANSFER_HOOK",
    "PAUSABLE_CONFIG",
  ]);
  const reviewExtensions = new Set([
    "TRANSFER_FEE_CONFIG",
    "MINT_CLOSE_AUTHORITY",
    "CONFIDENTIAL_TRANSFER_MINT",
    "DEFAULT_ACCOUNT_STATE",
    "INTEREST_BEARING_CONFIG",
    "CONFIDENTIAL_TRANSFER_FEE_CONFIG",
    "CONFIDENTIAL_MINT_BURN",
    "SCALED_UI_AMOUNT_CONFIG",
  ]);
  for (const extension of facts.extensions) {
    if (blockingExtensions.has(extension)) reasons.push(`BLOCKING_EXTENSION_${extension}`);
    else if (reviewExtensions.has(extension)) reasons.push(`REVIEW_EXTENSION_${extension}`);
  }
  if (facts.unknownExtensionTypes.length > 0) reasons.push("UNKNOWN_TOKEN_2022_EXTENSION");
  const hardBlock = reasons.some(
    (reason) =>
      ["UNRECOGNIZED_TOKEN_PROGRAM", "MINT_NOT_INITIALIZED", "FREEZE_AUTHORITY_ACTIVE"].includes(
        reason,
      ) || reason.startsWith("BLOCKING_EXTENSION_"),
  );
  const values = {
    version: 1 as const,
    status: hardBlock
      ? ("BLOCK" as const)
      : reasons.length
        ? ("REVIEW" as const)
        : ("PASS" as const),
    reasons,
    facts,
  };
  return { ...values, contentHash: contentHash(values) };
}
