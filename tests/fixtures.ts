/**
 * Fixtures with answers known by construction.
 *
 * Nothing here touches the network: tests run offline in milliseconds, and they
 * cannot fail because an API is slow, throttled, or has quietly changed shape.
 * A captured Etherscan payload is included verbatim (`RAW_ETHERSCAN_PAGE`) so
 * the parsing is pinned to the real response format rather than to my
 * assumptions about it.
 */

import type { Deployment, Transaction } from "@/lib/types";

export const WALLET = "0x1111111111111111111111111111111111111111";
export const OTHER = "0x2222222222222222222222222222222222222222";
export const THIRD = "0x3333333333333333333333333333333333333333";

/** Seconds since epoch for a UTC date, for readable fixtures. */
export function ts(iso: string): number {
  return Math.floor(new Date(`${iso}T12:00:00Z`).getTime() / 1000);
}

export function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    hash: `0x${Math.random().toString(16).slice(2)}`,
    timeStamp: ts("2024-01-15"),
    from: WALLET,
    to: OTHER,
    contractAddress: "",
    isError: false,
    ...overrides,
  };
}

/** A contract-creation transaction: no `to`, a `contractAddress` set. */
export function deploymentTx(contract: string, date: string): Transaction {
  return tx({ to: "", contractAddress: contract, timeStamp: ts(date) });
}

export function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    address: "0xaaaa000000000000000000000000000000000001",
    deployedAt: new Date("2024-01-15T12:00:00Z"),
    verified: true,
    ...overrides,
  };
}

/** Verbatim shape of an Etherscan v2 txlist row — everything is a string. */
export const RAW_ETHERSCAN_PAGE = [
  {
    hash: "0xabc",
    timeStamp: "1705320000",
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    contractAddress: "",
    isError: "0",
  },
  {
    hash: "0xdef",
    timeStamp: "1705406400",
    from: "0x1111111111111111111111111111111111111111",
    to: "",
    contractAddress: "0xAAAA000000000000000000000000000000000001",
    isError: "0",
  },
  {
    hash: "0xfa1",
    timeStamp: "1705492800",
    from: "0x1111111111111111111111111111111111111111",
    to: "",
    contractAddress: "0xAAAA000000000000000000000000000000000002",
    isError: "1",
  },
];
