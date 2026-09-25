import { describe, expect, it } from "vitest";
import {
  inspectMintAccount,
  LEGACY_TOKEN_PROGRAM,
  parseMintExtensions,
  TOKEN_2022_PROGRAM,
} from "../src/index.js";

const mintData = (mintAuthority: number, freezeAuthority: number): Uint8Array => {
  const data = new Uint8Array(82);
  const view = new DataView(data.buffer);
  view.setUint32(0, mintAuthority, true);
  view.setBigUint64(36, 1_000_000n, true);
  data[44] = 6;
  data[45] = 1;
  view.setUint32(46, freezeAuthority, true);
  return data;
};

describe("token safety", () => {
  it("passes an initialized fixed-supply legacy mint without freeze control", () => {
    expect(inspectMintAccount(mintData(0, 0), LEGACY_TOKEN_PROGRAM).status).toBe("PASS");
  });
  it("blocks active freeze authority", () => {
    const result = inspectMintAccount(mintData(0, 1), LEGACY_TOKEN_PROGRAM);
    expect(result.status).toBe("BLOCK");
    expect(result.reasons).toContain("FREEZE_AUTHORITY_ACTIVE");
  });
  it("requires review when supply can still be minted", () => {
    expect(inspectMintAccount(mintData(1, 0), LEGACY_TOKEN_PROGRAM).status).toBe("REVIEW");
  });

  it("parses Token-2022 TLV extensions after the padded mint layout", () => {
    const data = new Uint8Array(175);
    data.set(mintData(0, 0));
    data[165] = 1;
    new DataView(data.buffer).setUint16(166, 14, true);
    new DataView(data.buffer).setUint16(168, 5, true);
    expect(parseMintExtensions(data).names).toEqual(["TRANSFER_HOOK"]);
    expect(inspectMintAccount(data, TOKEN_2022_PROGRAM).status).toBe("BLOCK");
  });

  it("allows metadata-only Token-2022 mints through extension screening", () => {
    const data = new Uint8Array(170);
    data.set(mintData(0, 0));
    data[165] = 1;
    new DataView(data.buffer).setUint16(166, 19, true);
    new DataView(data.buffer).setUint16(168, 0, true);
    const result = inspectMintAccount(data, TOKEN_2022_PROGRAM);
    expect(result.status).toBe("PASS");
    expect(result.facts.extensions).toEqual(["TOKEN_METADATA"]);
  });
});
