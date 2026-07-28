import { describe, expect, it } from "vitest";

import { activeMonths, distinctCounterparties, outbound, summarise } from "@/lib/activity";
import { findDeploymentTransactions, parseTransactions } from "@/lib/etherscan";

import { OTHER, RAW_ETHERSCAN_PAGE, THIRD, WALLET, deploymentTx, ts, tx } from "./fixtures";

const NOW = new Date("2026-07-01T00:00:00Z");

describe("parseTransactions", () => {
  it("normalises the explorer's all-strings payload", () => {
    const parsed = parseTransactions(RAW_ETHERSCAN_PAGE);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].timeStamp).toBe(1_705_320_000);
    expect(parsed[0].isError).toBe(false);
    expect(parsed[2].isError).toBe(true);
  });

  it("lowercases addresses so comparisons are safe", () => {
    // The explorer returns checksummed contract addresses but lowercase `from`.
    const parsed = parseTransactions(RAW_ETHERSCAN_PAGE);
    expect(parsed[1].contractAddress).toBe("0xaaaa000000000000000000000000000000000001");
  });
});

describe("findDeploymentTransactions", () => {
  it("finds creations and ignores ordinary transfers", () => {
    const found = findDeploymentTransactions(parseTransactions(RAW_ETHERSCAN_PAGE), WALLET);
    expect(found.map((t) => t.contractAddress)).toEqual([
      "0xaaaa000000000000000000000000000000000001",
    ]);
  });

  it("excludes failed deployments, which shipped nothing", () => {
    const found = findDeploymentTransactions(parseTransactions(RAW_ETHERSCAN_PAGE), WALLET);
    expect(found.map((t) => t.hash)).not.toContain("0xfa1");
  });

  it("ignores creations by other addresses", () => {
    const foreign = tx({ from: OTHER, to: "", contractAddress: "0xbbbb" });
    expect(findDeploymentTransactions([foreign], WALLET)).toHaveLength(0);
  });
});

describe("outbound", () => {
  it("counts only transactions sent by the address", () => {
    const history = [
      tx({ from: WALLET }),
      tx({ from: OTHER, to: WALLET }), // received, not activity
    ];
    expect(outbound(history, WALLET)).toHaveLength(1);
  });
});

describe("activeMonths", () => {
  it("counts distinct calendar months, not transactions", () => {
    // Many transactions inside one month is still one month of activity.
    const burst = [
      tx({ timeStamp: ts("2025-03-01") }),
      tx({ timeStamp: ts("2025-03-15") }),
      tx({ timeStamp: ts("2025-03-28") }),
    ];
    expect(activeMonths(burst)).toBe(1);
  });

  it("rewards a long thin drip over a short fat burst", () => {
    const drip = [
      tx({ timeStamp: ts("2025-01-10") }),
      tx({ timeStamp: ts("2025-02-10") }),
      tx({ timeStamp: ts("2025-03-10") }),
    ];
    const burst = [
      tx({ timeStamp: ts("2025-03-01") }),
      tx({ timeStamp: ts("2025-03-02") }),
      tx({ timeStamp: ts("2025-03-03") }),
    ];
    expect(activeMonths(drip)).toBeGreaterThan(activeMonths(burst));
  });

  it("does not merge the same month of different years", () => {
    const twoYears = [tx({ timeStamp: ts("2024-05-10") }), tx({ timeStamp: ts("2025-05-10") })];
    expect(activeMonths(twoYears)).toBe(2);
  });
});

describe("distinctCounterparties", () => {
  it("counts unique destinations", () => {
    const history = [tx({ to: OTHER }), tx({ to: OTHER }), tx({ to: THIRD })];
    expect(distinctCounterparties(history)).toBe(2);
  });

  it("excludes contract creations, which have no destination", () => {
    // Those are counted by the deployments signal instead of double-counted here.
    const history = [tx({ to: OTHER }), deploymentTx("0xaaaa", "2025-01-01")];
    expect(distinctCounterparties(history)).toBe(1);
  });
});

describe("summarise", () => {
  it("derives dates and age from the first and last outbound transaction", () => {
    const history = [
      tx({ timeStamp: ts("2024-01-01") }),
      tx({ timeStamp: ts("2025-01-01") }),
    ];
    const result = summarise(WALLET, history, [], null, NOW);
    expect(result.firstSeen?.toISOString().slice(0, 10)).toBe("2024-01-01");
    expect(result.lastSeen?.toISOString().slice(0, 10)).toBe("2025-01-01");
    // 2024-01-01 to 2026-07-01 is two and a half years.
    expect(result.accountAgeDays).toBeGreaterThan(900);
  });

  it("handles an address with no history at all", () => {
    const result = summarise(WALLET, [], [], null, NOW);
    expect(result.firstSeen).toBeNull();
    expect(result.accountAgeDays).toBe(0);
    expect(result.txCount).toBe(0);
  });

  it("does not let inbound transfers age the account", () => {
    // Being sent funds is not evidence the owner did anything.
    const history = [
      tx({ from: OTHER, to: WALLET, timeStamp: ts("2019-01-01") }),
      tx({ from: WALLET, timeStamp: ts("2025-01-01") }),
    ];
    const result = summarise(WALLET, history, [], null, NOW);
    expect(result.firstSeen?.getUTCFullYear()).toBe(2025);
  });

  it("flags truncation only when the explorer's page limit was hit", () => {
    const small = summarise(WALLET, [tx()], [], null, NOW);
    expect(small.truncated).toBe(false);

    const full = summarise(WALLET, Array.from({ length: 10_000 }, () => tx()), [], null, NOW);
    expect(full.truncated).toBe(true);
  });
});
