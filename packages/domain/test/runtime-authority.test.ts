import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeAuthority } from "../src/runtime-authority.js";

describe("runtime authority", () => {
  it("exposes only the approved read-only research capabilities", () => {
    expect(runtimeAuthority).toEqual({
      manifestVersion: "1",
      authority: "READ_ONLY_RESEARCH",
      chain_read: true,
      market_read: true,
      wallet_read: false,
      signing: false,
      transaction_submit: false,
      exchange_trade: false,
      withdrawal: false,
      capital_allocation: false,
    });
  });

  it("matches the checked-in machine-readable manifest", async () => {
    const path = resolve(process.cwd(), "config/runtime-authority.json");
    // The path is a fixed repository-relative test fixture.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const manifest = JSON.parse(await readFile(path, "utf8")) as unknown;
    expect(manifest).toEqual(runtimeAuthority);
  });
});
