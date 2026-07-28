import { describe, expect, it } from "vitest";

import { summarise } from "@/lib/activity";
import { SIGNALS, buildProfile, caveats, saturate, scoreComponents } from "@/lib/scoring";
import type { ActivitySummary } from "@/lib/types";

import { WALLET, deployment } from "./fixtures";

const NOW = new Date("2026-07-01T00:00:00Z");

function summary(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    ...summarise(WALLET, [], [], null, NOW),
    ...overrides,
  };
}

describe("saturate", () => {
  it("is zero at zero and full marks at the stated level", () => {
    expect(saturate(0, 10)).toBe(0);
    expect(saturate(10, 10)).toBeCloseTo(1);
  });

  it("never exceeds one, however extreme the input", () => {
    // The point of the curve: one whale must not flatten everyone else.
    expect(saturate(1_000_000, 10)).toBe(1);
  });

  it("rises steeply at first, then flattens", () => {
    const firstStep = saturate(1, 100) - saturate(0, 100);
    const laterStep = saturate(51, 100) - saturate(50, 100);
    expect(firstStep).toBeGreaterThan(laterStep);
  });

  it("treats negative and non-finite input as zero", () => {
    expect(saturate(-5, 10)).toBe(0);
    expect(saturate(Number.NaN, 10)).toBe(0);
  });
});

describe("weights", () => {
  it("sum to one before any renormalising", () => {
    const total = SIGNALS.reduce((sum, s) => sum + s.weight, 0);
    expect(total).toBeCloseTo(1);
  });

  it("value shipping code above transaction volume", () => {
    const byKey = Object.fromEntries(SIGNALS.map((s) => [s.key, s.weight]));
    expect(byKey.deployments).toBeGreaterThan(byKey.txCount);
    expect(byKey.deployments).toBeGreaterThan(byKey.counterparties);
  });
});

describe("scoreComponents", () => {
  it("skips the verified-source signal when nothing was deployed", () => {
    const components = scoreComponents(summary({ deployments: [] }));
    expect(components.map((c) => c.key)).not.toContain("verifiedRatio");
  });

  it("redistributes a skipped signal's weight instead of capping the maximum", () => {
    const withoutDeployments = scoreComponents(summary({ deployments: [] }));
    const total = withoutDeployments.reduce((sum, c) => sum + c.weight, 0);
    // Weights still sum to 1, so a perfect score remains reachable.
    expect(total).toBeCloseTo(1);
  });

  it("scores an unverified deployer below an identical verified one", () => {
    const base = {
      txCount: 100,
      activeMonths: 12,
      distinctCounterparties: 20,
      accountAgeDays: 400,
      firstSeen: new Date("2025-05-01T00:00:00Z"),
    };
    const verified = buildProfile(
      summary({ ...base, deployments: [deployment({ verified: true })] }),
      NOW,
    );
    const unverified = buildProfile(
      summary({ ...base, deployments: [deployment({ verified: false })] }),
      NOW,
    );
    expect(verified.score).toBeGreaterThan(unverified.score);
  });

  it("reports a contribution for every component that adds up to the score", () => {
    const profile = buildProfile(
      summary({
        txCount: 250,
        activeMonths: 20,
        distinctCounterparties: 40,
        accountAgeDays: 900,
        firstSeen: new Date("2024-01-01T00:00:00Z"),
        deployments: [deployment(), deployment({ verified: false })],
      }),
      NOW,
    );
    const summed = profile.components.reduce((sum, c) => sum + c.contribution, 0);
    expect(profile.score).toBeCloseTo(summed);
    expect(profile.score).toBeGreaterThan(0);
    expect(profile.score).toBeLessThanOrEqual(1);
  });

  it("gives an empty wallet a score of zero without crashing", () => {
    const profile = buildProfile(summary(), NOW);
    expect(profile.score).toBe(0);
  });
});

describe("caveats", () => {
  it("always states that an address is not a person", () => {
    const keys = caveats(summary(), NOW).map((c) => c.key);
    expect(keys).toContain("identity");
  });

  it("says so when there are no deployments to judge", () => {
    const keys = caveats(summary({ deployments: [] }), NOW).map((c) => c.key);
    expect(keys).toContain("noDeployments");
  });

  it("flags busy wallets that only ever talk to one place", () => {
    const keys = caveats(
      summary({ txCount: 500, distinctCounterparties: 1 }),
      NOW,
    ).map((c) => c.key);
    expect(keys).toContain("concentratedActivity");
  });

  it("does not flag a busy wallet with a broad set of counterparties", () => {
    const keys = caveats(
      summary({ txCount: 500, distinctCounterparties: 80 }),
      NOW,
    ).map((c) => c.key);
    expect(keys).not.toContain("concentratedActivity");
  });

  it("marks a long-idle wallet as historical", () => {
    const keys = caveats(
      summary({ lastSeen: new Date("2023-01-01T00:00:00Z") }),
      NOW,
    ).map((c) => c.key);
    expect(keys).toContain("dormant");
  });

  it("warns when there is too little history to judge", () => {
    const keys = caveats(
      summary({ firstSeen: new Date("2026-06-01T00:00:00Z"), accountAgeDays: 30 }),
      NOW,
    ).map((c) => c.key);
    expect(keys).toContain("shortHistory");
  });

  it("admits when the explorer truncated the history", () => {
    const keys = caveats(summary({ truncated: true }), NOW).map((c) => c.key);
    expect(keys).toContain("truncated");
  });
});
