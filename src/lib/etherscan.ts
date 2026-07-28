/**
 * Etherscan v2 client.
 *
 * Two things make this more than a fetch wrapper. The free tier allows about
 * five calls a second, so requests are serialised through a small spacing gate
 * rather than fired in parallel and hoping — checking a wallet with twenty
 * deployments means twenty source-verification lookups, which is exactly the
 * shape of request burst that gets an API key rate-limited. And responses are
 * cached in-process, because the same address gets looked at repeatedly during
 * development and every avoided call is one you cannot be throttled for.
 *
 * Parsing is kept separate from fetching (see `summariseTransactions`) so the
 * interesting logic can be tested against captured fixtures without a network.
 */

import type { Deployment, Transaction } from "./types";

const BASE_URL = "https://api.etherscan.io/v2/api";
const MAINNET = 1;

/** Etherscan caps a txlist page at 10,000 rows. */
export const TX_PAGE_LIMIT = 10_000;

/** Free tier is ~5 requests/second; leave headroom. */
const MIN_REQUEST_SPACING_MS = 220;

const cache = new Map<string, unknown>();
let nextSlot = 0;

/** Serialise requests, spacing them to stay inside the rate limit. */
async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_REQUEST_SPACING_MS;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

export class EtherscanError extends Error {}

async function request<T>(params: Record<string, string>): Promise<T> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    throw new EtherscanError(
      "ETHERSCAN_API_KEY is not set. Add it to .env.local (see README).",
    );
  }

  const url = new URL(BASE_URL);
  url.searchParams.set("chainid", String(MAINNET));
  url.searchParams.set("apikey", apiKey);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const cacheKey = url.toString().replace(apiKey, "KEY");
  if (cache.has(cacheKey)) return cache.get(cacheKey) as T;

  await throttle();
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new EtherscanError(`Etherscan HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    status: string;
    message: string;
    result: T | string;
  };

  // Etherscan signals "nothing found" as status 0 with an explanatory message,
  // which is not an error: a brand-new address legitimately has no history.
  if (body.status === "0") {
    if (typeof body.result === "string" && /rate limit/i.test(body.result)) {
      throw new EtherscanError(`Etherscan rate limit: ${body.result}`);
    }
    if (/no transactions found/i.test(body.message)) {
      return [] as unknown as T;
    }
    throw new EtherscanError(
      `Etherscan: ${body.message}${typeof body.result === "string" ? ` (${body.result})` : ""}`,
    );
  }

  cache.set(cacheKey, body.result);
  return body.result as T;
}

interface RawTransaction {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  contractAddress: string;
  isError: string;
}

/** Normalise the explorer's all-strings payload into typed transactions. */
export function parseTransactions(raw: RawTransaction[]): Transaction[] {
  return raw.map((tx) => ({
    hash: tx.hash,
    timeStamp: Number(tx.timeStamp),
    from: (tx.from ?? "").toLowerCase(),
    to: (tx.to ?? "").toLowerCase(),
    contractAddress: (tx.contractAddress ?? "").toLowerCase(),
    isError: tx.isError === "1",
  }));
}

export async function fetchTransactions(address: string): Promise<Transaction[]> {
  const raw = await request<RawTransaction[]>({
    module: "account",
    action: "txlist",
    address,
    startblock: "0",
    endblock: "99999999",
    page: "1",
    offset: String(TX_PAGE_LIMIT),
    sort: "asc",
  });
  return parseTransactions(Array.isArray(raw) ? raw : []);
}

interface RawSource {
  SourceCode: string;
  ContractName: string;
}

/** Whether a contract's source is published, plus its name if so. */
export async function fetchVerification(
  address: string,
): Promise<{ verified: boolean; name?: string }> {
  const raw = await request<RawSource[]>({
    module: "contract",
    action: "getsourcecode",
    address,
  });
  const entry = Array.isArray(raw) ? raw[0] : undefined;
  if (!entry || !entry.SourceCode) return { verified: false };
  return { verified: true, name: entry.ContractName || undefined };
}

/**
 * Contract-creation transactions: `to` is empty and `contractAddress` is set.
 * Failed creations are excluded — a reverted deployment shipped nothing.
 */
export function findDeploymentTransactions(
  transactions: Transaction[],
  address: string,
): Transaction[] {
  const self = address.toLowerCase();
  return transactions.filter(
    (tx) => tx.from === self && tx.to === "" && tx.contractAddress !== "" && !tx.isError,
  );
}

export async function fetchDeployments(
  transactions: Transaction[],
  address: string,
): Promise<Deployment[]> {
  const creations = findDeploymentTransactions(transactions, address);
  const out: Deployment[] = [];
  for (const tx of creations) {
    // Sequential on purpose: see the throttle note at the top of this file.
    const { verified, name } = await fetchVerification(tx.contractAddress);
    out.push({
      address: tx.contractAddress,
      deployedAt: new Date(tx.timeStamp * 1000),
      verified,
      name,
    });
  }
  return out;
}

/** Exposed for tests; clears the in-process response cache. */
export function clearCache(): void {
  cache.clear();
  nextSlot = 0;
}
