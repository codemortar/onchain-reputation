/**
 * Etherscan v2 client.
 *
 * Three things make this more than a fetch wrapper. Requests are serialised
 * through a spacing gate rather than fired in parallel and hoping — checking a
 * wallet with twenty deployments means twenty source-verification lookups,
 * which is exactly the shape of burst that gets an API key throttled. A
 * rate-limit response is retried with exponential backoff rather than surfaced,
 * because spacing alone cannot prevent it: the free tier's ceiling varies by
 * key, other processes may share it, and a page can be requested twice before
 * the first render finishes. And responses are cached in-process, because the
 * same address gets looked at repeatedly during development and every avoided
 * call is one you cannot be throttled for.
 *
 * Both the gate and the cache live on globalThis rather than at module scope.
 * That is not a style preference: Next.js gives each bundling layer its own
 * copy of a module, so the page and the API route would otherwise throttle
 * independently and blow the shared limit between them. See `SharedState`.
 *
 * Parsing is kept separate from fetching (see `summariseTransactions`) so the
 * interesting logic can be tested against captured fixtures without a network.
 */

import type { Deployment, Transaction } from "./types";

const BASE_URL = "https://api.etherscan.io/v2/api";
const MAINNET = 1;

/** Etherscan caps a txlist page at 10,000 rows. */
export const TX_PAGE_LIMIT = 10_000;

/**
 * Gap between requests. Free keys are commonly limited to 3/second and some to
 * less, so the default is deliberately slower than any published ceiling —
 * being throttled costs a retry and a second of backoff, while being 100ms
 * slower costs almost nothing. Raise it with ETHERSCAN_MIN_SPACING_MS on a paid
 * tier.
 */
const MIN_REQUEST_SPACING_MS = Number(process.env.ETHERSCAN_MIN_SPACING_MS) || 400;

/** Attempts after a rate-limit response before giving up, and the first delay. */
const MAX_RATE_LIMIT_RETRIES = 4;
const RETRY_BASE_MS = 800;

/**
 * Most deployments we will check the source of for one profile.
 *
 * Verification is one serialised request per contract, so an address with
 * hundreds of deployments would otherwise spend minutes in the spacing gate and
 * blow past any sensible request timeout. Past the cap the remaining contracts
 * are still listed and still counted by the deployments signal; only their
 * verification status is left unknown, which the profile says out loud rather
 * than reporting as unverified.
 */
export const VERIFICATION_LIMIT = 25;

/**
 * Bound on cached responses. The cache is a plain map held for the life of the
 * process, so without a ceiling a long-lived server accumulates every address
 * ever looked at. Oldest insertion is evicted first, which suits the access
 * pattern here: a burst of requests about one address, then never again.
 */
const MAX_CACHE_ENTRIES = 500;

/**
 * The gate and the cache, pinned to the process rather than to this module.
 *
 * Next.js instantiates a module once per bundling layer, so a Server Component
 * and a Route Handler importing this file get *separate copies* of anything
 * declared at module scope — and HMR replaces them again on every edit. A
 * module-level `nextSlot` is therefore not one gate but several, each happily
 * spacing its own requests while collectively exceeding the limit, which is
 * exactly how a correct-looking 400ms gap still earns a 3/sec refusal. Hanging
 * the state off globalThis gives one gate and one cache for the whole process.
 */
interface SharedState {
  cache: Map<string, unknown>;
  nextSlot: number;
}

const STATE_KEY = "__onchainReputationEtherscan";

const store = globalThis as typeof globalThis & { [STATE_KEY]?: SharedState };
const shared: SharedState = (store[STATE_KEY] ??= { cache: new Map(), nextSlot: 0 });

function remember(key: string, value: unknown): void {
  // Re-inserting moves a key to the end, so eviction stays insertion-ordered.
  shared.cache.delete(key);
  shared.cache.set(key, value);
  if (shared.cache.size > MAX_CACHE_ENTRIES) {
    const oldest = shared.cache.keys().next();
    if (!oldest.done) shared.cache.delete(oldest.value);
  }
}

/** Serialise requests, spacing them to stay inside the rate limit. */
async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, shared.nextSlot - now);
  shared.nextSlot = Math.max(now, shared.nextSlot) + MIN_REQUEST_SPACING_MS;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

export class EtherscanError extends Error {}

/** Internal signal that the explorer throttled us; never escapes `request`. */
class RateLimited extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One trip to the explorer. Throws RateLimited so the caller can back off. */
async function attempt<T>(url: URL): Promise<T> {
  await throttle();
  const response = await fetch(url, { headers: { accept: "application/json" } });

  // 429 is the documented throttle status; treat it like an in-body rate limit
  // rather than a hard failure, since it is the same problem.
  if (response.status === 429) {
    throw new RateLimited("HTTP 429");
  }
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
      throw new RateLimited(body.result);
    }
    if (/no transactions found/i.test(body.message)) {
      // "This address has no history" is a real answer and worth caching, which
      // is why it returns a value rather than throwing.
      return [] as unknown as T;
    }
    throw new EtherscanError(
      `Etherscan: ${body.message}${typeof body.result === "string" ? ` (${body.result})` : ""}`,
    );
  }

  return body.result as T;
}

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

  // Keyed without the secret, so the cache cannot leak it if ever dumped.
  const cacheKey = url.toString().replace(apiKey, "KEY");
  if (shared.cache.has(cacheKey)) return shared.cache.get(cacheKey) as T;

  for (let retries = 0; ; retries++) {
    try {
      const result = await attempt<T>(url);
      remember(cacheKey, result);
      return result;
    } catch (error) {
      if (!(error instanceof RateLimited)) throw error;
      if (retries >= MAX_RATE_LIMIT_RETRIES) {
        throw new EtherscanError(
          `Etherscan rate limit after ${retries} retries: ${error.message}. ` +
            "Raise ETHERSCAN_MIN_SPACING_MS if this keeps happening.",
        );
      }
      // Exponential backoff, and push the shared gate out too so every other
      // queued request slows down rather than piling into the same limit.
      const delay = RETRY_BASE_MS * 2 ** retries;
      shared.nextSlot = Math.max(shared.nextSlot, Date.now() + delay);
      await sleep(delay);
    }
  }
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

/**
 * Which creations get a source lookup and which are listed unchecked.
 *
 * Split out from the fetching so the cap can be tested without standing through
 * the spacing gate for every contract. Newest first: if we can only afford to
 * check some, the recent work is the more informative half.
 */
export function splitByVerificationLimit(creations: Transaction[]): {
  check: Transaction[];
  skip: Transaction[];
} {
  const newestFirst = [...creations].sort((a, b) => b.timeStamp - a.timeStamp);
  return {
    check: newestFirst.slice(0, VERIFICATION_LIMIT),
    skip: newestFirst.slice(VERIFICATION_LIMIT),
  };
}

export async function fetchDeployments(
  transactions: Transaction[],
  address: string,
): Promise<Deployment[]> {
  const { check, skip } = splitByVerificationLimit(
    findDeploymentTransactions(transactions, address),
  );

  const out: Deployment[] = [];
  for (const tx of check) {
    // Sequential on purpose: see the throttle note at the top of this file.
    const { verified, name } = await fetchVerification(tx.contractAddress);
    out.push({
      address: tx.contractAddress,
      deployedAt: new Date(tx.timeStamp * 1000),
      verified,
      name,
    });
  }
  for (const tx of skip) {
    // Still a deployment, just one whose source we did not stop to check.
    // Null rather than false — see VERIFICATION_LIMIT.
    out.push({
      address: tx.contractAddress,
      deployedAt: new Date(tx.timeStamp * 1000),
      verified: null,
    });
  }
  return out;
}

/** Exposed for tests; clears the in-process response cache. */
export function clearCache(): void {
  shared.cache.clear();
  shared.nextSlot = 0;
}
