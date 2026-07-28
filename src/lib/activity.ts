/**
 * Reducing a transaction history to the handful of facts worth scoring.
 *
 * Pure functions only — no network, no clock beyond what is passed in — so the
 * counting rules can be tested against fixtures with answers known by
 * construction. Every choice here is a judgement about what "activity" means,
 * and those choices deserve to be visible and testable rather than buried in
 * the middle of a fetch.
 */

import type { ActivitySummary, Deployment, Transaction } from "./types";
import { TX_PAGE_LIMIT } from "./etherscan";

const DAY_MS = 86_400_000;

/** Transactions *sent* by the address; inbound transfers are not activity. */
export function outbound(transactions: Transaction[], address: string): Transaction[] {
  const self = address.toLowerCase();
  return transactions.filter((tx) => tx.from === self);
}

/**
 * Distinct calendar months (UTC) containing at least one outbound transaction.
 *
 * Preferred over raw counts as a persistence signal: a thousand transactions in
 * one week is one active month, while one a month for three years is thirty-six.
 * The second pattern is much harder to manufacture and much more informative.
 */
export function activeMonths(transactions: Transaction[]): number {
  const months = new Set<string>();
  for (const tx of transactions) {
    const date = new Date(tx.timeStamp * 1000);
    months.add(`${date.getUTCFullYear()}-${date.getUTCMonth()}`);
  }
  return months.size;
}

/**
 * Distinct non-empty destinations. Contract creations have no `to`, so they are
 * excluded here and counted by the deployments signal instead.
 */
export function distinctCounterparties(transactions: Transaction[]): number {
  const seen = new Set<string>();
  for (const tx of transactions) {
    if (tx.to) seen.add(tx.to);
  }
  return seen.size;
}

export function summarise(
  address: string,
  transactions: Transaction[],
  deployments: Deployment[],
  ensName: string | null,
  now: Date = new Date(),
): ActivitySummary {
  const sent = outbound(transactions, address);
  const stamps = sent.map((tx) => tx.timeStamp).sort((a, b) => a - b);
  const firstSeen = stamps.length ? new Date(stamps[0] * 1000) : null;
  const lastSeen = stamps.length ? new Date(stamps[stamps.length - 1] * 1000) : null;

  return {
    address: address.toLowerCase(),
    ensName,
    firstSeen,
    lastSeen,
    accountAgeDays: firstSeen
      ? Math.max(0, Math.floor((now.getTime() - firstSeen.getTime()) / DAY_MS))
      : 0,
    txCount: sent.length,
    activeMonths: activeMonths(sent),
    distinctCounterparties: distinctCounterparties(sent),
    deployments,
    // A full page back means the explorer stopped, not that history did.
    truncated: transactions.length >= TX_PAGE_LIMIT,
  };
}
