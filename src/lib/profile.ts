/**
 * Orchestration: an address or ENS name in, a scored profile out.
 *
 * Two data sources, each for what it is actually good at. The block explorer
 * provides transaction history and source verification; a plain JSON-RPC node
 * (via viem) resolves ENS both ways. Keeping them separate means an ENS failure
 * degrades to "no name" instead of taking the whole profile down with it.
 */

import { createPublicClient, http, isAddress, type Address } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";

import { summarise } from "./activity";
import { fetchDeployments, fetchTransactions } from "./etherscan";
import { buildProfile } from "./scoring";
import type { Profile } from "./types";

/**
 * Public endpoint by default so the project runs with only an explorer key.
 * PublicNode rather than Cloudflare: the latter's ENS universal resolver call
 * reverts with an internal error, which breaks name lookups. Override with
 * ETHEREUM_RPC_URL to point at your own node or a provider with an SLA.
 */
const RPC_URL = process.env.ETHEREUM_RPC_URL ?? "https://ethereum-rpc.publicnode.com";

const client = createPublicClient({ chain: mainnet, transport: http(RPC_URL) });

export class InvalidAddressError extends Error {}

/** Accept either a hex address or an ENS name, returning a checksummed address. */
export async function resolveInput(input: string): Promise<Address> {
  const trimmed = input.trim();
  if (isAddress(trimmed)) return trimmed as Address;

  if (trimmed.includes(".")) {
    const resolved = await client.getEnsAddress({ name: normalize(trimmed) });
    if (resolved) return resolved;
    throw new InvalidAddressError(`Could not resolve ENS name "${trimmed}".`);
  }
  throw new InvalidAddressError(
    `"${trimmed}" is not a valid Ethereum address or ENS name.`,
  );
}

/** Reverse ENS lookup. Best-effort: a failure must not fail the profile. */
async function lookupEnsName(address: Address): Promise<string | null> {
  try {
    return await client.getEnsName({ address });
  } catch {
    return null;
  }
}

export async function getProfile(input: string, now: Date = new Date()): Promise<Profile> {
  const address = await resolveInput(input);
  const transactions = await fetchTransactions(address);
  const [deployments, ensName] = await Promise.all([
    fetchDeployments(transactions, address),
    lookupEnsName(address),
  ]);
  return buildProfile(summarise(address, transactions, deployments, ensName, now), now);
}
