/**
 * Turning on-chain activity into a reputation score.
 *
 * The scoring is deliberately boring and completely visible: each signal is
 * normalised to 0..1 by a documented curve, then combined with a fixed weight.
 * Every component is returned with its raw value and its contribution, so a
 * score can always be taken apart and argued with. A number nobody can
 * interrogate is worse than no number at all, and reputation systems live or
 * die on whether the subject can see why they were rated the way they were.
 *
 * What this cannot do is judge quality. It counts deployments; it cannot read
 * the contracts. It counts sustained activity; it cannot tell a careful
 * engineer from a busy bot. Those limits are returned as caveats rather than
 * buried in a footnote, because the failure mode of reputation scoring is
 * confident nonsense.
 */

import type { ActivitySummary, Caveat, Profile, ScoreComponent } from "./types";

/**
 * Saturating curve: 0 at zero, 1 at `full`, compressing above it.
 *
 * Counts of on-chain activity are heavily skewed — a handful of addresses have
 * thousands of transactions. Scoring them linearly would let one whale flatten
 * everyone else into the bottom of the range, so growth is logarithmic and
 * capped: reaching `full` earns top marks, and going far beyond it earns no more.
 */
export function saturate(value: number, full: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (full <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(full));
}

interface SignalSpec {
  key: string;
  label: string;
  weight: number;
  /** Full marks at this level (omitted when the signal is already 0..1). */
  full?: number;
  explanation: string;
  /** Pull the raw measurement out of the summary. */
  raw: (s: ActivitySummary) => number;
  /** When false the signal is skipped and its weight redistributed. */
  available: (s: ActivitySummary) => boolean;
}

/**
 * Weights encode a view: shipping code matters most, and raw transaction
 * volume matters least because it is the cheapest thing to manufacture.
 */
export const SIGNALS: SignalSpec[] = [
  {
    key: "deployments",
    label: "Contracts deployed",
    weight: 0.3,
    full: 10,
    explanation:
      "Contract-creation transactions sent by this address. The clearest " +
      "on-chain evidence that someone ships rather than only transacts.",
    raw: (s) => s.deployments.length,
    available: () => true,
  },
  {
    key: "verifiedRatio",
    label: "Deployments with published source",
    weight: 0.2,
    explanation:
      "Share of deployed contracts whose source is verified on the explorer. " +
      "Publishing source is a deliberate act and a reasonable proxy for work " +
      "meant to be used by others.",
    raw: (s) =>
      s.deployments.length === 0
        ? 0
        : s.deployments.filter((d) => d.verified).length / s.deployments.length,
    // Meaningless with nothing deployed: skipped rather than scored as zero.
    available: (s) => s.deployments.length > 0,
  },
  {
    key: "activeMonths",
    label: "Months with activity",
    weight: 0.2,
    full: 36,
    explanation:
      "Distinct calendar months containing at least one outbound transaction. " +
      "Rewards sustained presence, and is far harder to fake cheaply than a " +
      "raw transaction count.",
    raw: (s) => s.activeMonths,
    available: () => true,
  },
  {
    key: "accountAge",
    label: "Account age",
    weight: 0.15,
    full: 1825, // five years
    explanation: "Days since the first transaction from this address.",
    raw: (s) => s.accountAgeDays,
    available: (s) => s.firstSeen !== null,
  },
  {
    key: "counterparties",
    label: "Distinct counterparties",
    weight: 0.1,
    full: 100,
    explanation:
      "Distinct addresses transacted with. A breadth signal: a wallet that " +
      "only ever talks to one contract looks automated.",
    raw: (s) => s.distinctCounterparties,
    available: () => true,
  },
  {
    key: "txCount",
    label: "Transactions sent",
    weight: 0.05,
    full: 500,
    explanation:
      "Total outbound transactions. Weighted lightly on purpose — it is the " +
      "easiest signal here to inflate.",
    raw: (s) => s.txCount,
    available: () => true,
  },
];

export function scoreComponents(summary: ActivitySummary): ScoreComponent[] {
  const usable = SIGNALS.filter((s) => s.available(summary));
  const totalWeight = usable.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight === 0) return [];

  return usable.map((signal) => {
    const raw = signal.raw(summary);
    const normalised =
      signal.full === undefined
        ? Math.min(1, Math.max(0, raw))
        : saturate(raw, signal.full);
    // Weights are renormalised over the signals that applied, so skipping one
    // redistributes its influence instead of silently capping the maximum.
    const weight = signal.weight / totalWeight;
    return {
      key: signal.key,
      label: signal.label,
      raw,
      normalised,
      weight,
      contribution: normalised * weight,
      explanation: signal.explanation,
    };
  });
}

/** Cheap heuristics for "this number may not mean what you think". */
export function caveats(summary: ActivitySummary, now: Date = new Date()): Caveat[] {
  const out: Caveat[] = [];

  if (summary.deployments.length === 0) {
    out.push({
      key: "noDeployments",
      message:
        "No contract deployments found, so this measures wallet activity, not " +
        "development. Plenty of good engineers deploy from a different address.",
    });
  }

  if (summary.txCount >= 50 && summary.distinctCounterparties <= 3) {
    out.push({
      key: "concentratedActivity",
      message:
        "High transaction count against very few counterparties, which is a " +
        "common shape for bots and scripted wallets.",
    });
  }

  if (summary.lastSeen) {
    const daysIdle = (now.getTime() - summary.lastSeen.getTime()) / 86_400_000;
    if (daysIdle > 365) {
      out.push({
        key: "dormant",
        message:
          `No activity for ${Math.floor(daysIdle / 365)}+ year(s); this is a ` +
          "historical record, not a current one.",
      });
    }
  }

  if (summary.firstSeen && summary.accountAgeDays < 90) {
    out.push({
      key: "shortHistory",
      message:
        "Less than three months of history. Too little to distinguish a new " +
        "developer from a throwaway address.",
    });
  }

  if (summary.truncated) {
    out.push({
      key: "truncated",
      message:
        "The explorer returned its maximum page of transactions, so counts " +
        "here are a floor rather than a total.",
    });
  }

  out.push({
    key: "identity",
    message:
      "An address is not a person. It proves control of a key, not authorship, " +
      "and one person may use many addresses.",
  });

  return out;
}

export function buildProfile(summary: ActivitySummary, now: Date = new Date()): Profile {
  const components = scoreComponents(summary);
  const score = components.reduce((sum, c) => sum + c.contribution, 0);
  return { summary, score, components, caveats: caveats(summary, now) };
}
