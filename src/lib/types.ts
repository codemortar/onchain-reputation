/** Shared shapes for on-chain activity and the profile derived from it. */

/** A normal (non-internal) transaction, reduced to the fields we score on. */
export interface Transaction {
  hash: string;
  /** Unix seconds. */
  timeStamp: number;
  from: string;
  /** Empty when the transaction created a contract. */
  to: string;
  /** Set only on contract-creation transactions. */
  contractAddress: string;
  isError: boolean;
}

export interface Deployment {
  address: string;
  deployedAt: Date;
  /**
   * Whether the source is published on the block explorer. Null when the
   * lookup was skipped because the address had more deployments than the
   * per-profile verification cap (see VERIFICATION_LIMIT in etherscan.ts).
   */
  verified: boolean | null;
  /** Contract name from the verified source, when available. */
  name?: string;
}

/** Raw, un-scored facts about an address. */
export interface ActivitySummary {
  address: string;
  ensName: string | null;
  firstSeen: Date | null;
  lastSeen: Date | null;
  accountAgeDays: number;
  /** Outbound transactions sent by this address. */
  txCount: number;
  /** Distinct calendar months in which the address sent at least one tx. */
  activeMonths: number;
  /** Distinct addresses this address sent transactions to. */
  distinctCounterparties: number;
  deployments: Deployment[];
  /** True when the explorer capped the transaction list (see etherscan.ts). */
  truncated: boolean;
}

export interface ScoreComponent {
  key: string;
  label: string;
  /** The underlying measurement, before normalising. */
  raw: number;
  /** Normalised to 0..1. */
  normalised: number;
  weight: number;
  /** normalised * (weight after renormalising over available components). */
  contribution: number;
  explanation: string;
}

/** Something the score cannot tell you, stated explicitly. */
export interface Caveat {
  key: string;
  message: string;
}

export interface Profile {
  summary: ActivitySummary;
  /** 0..1, where 1 is the top of every scale used here. */
  score: number;
  components: ScoreComponent[];
  caveats: Caveat[];
}
