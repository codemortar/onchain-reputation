/**
 * Rate-limit handling and caching.
 *
 * `fetch` is stubbed and the clock is faked, so the backoff is exercised
 * properly without the suite ever waiting a real second or touching the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EtherscanError, clearCache, fetchTransactions } from "@/lib/etherscan";

const ADDRESS = "0x1111111111111111111111111111111111111111";

/** Shape of a throttled Etherscan reply: HTTP 200 with the refusal in-body. */
const RATE_LIMITED = {
  status: "0",
  message: "NOTOK",
  result: "Max calls per sec rate limit reached (3/sec)",
};

const ONE_TX = {
  status: "1",
  message: "OK",
  result: [
    {
      hash: "0xabc",
      timeStamp: "1705320000",
      from: ADDRESS,
      to: "0x2222222222222222222222222222222222222222",
      contractAddress: "",
      isError: "0",
    },
  ],
};

function reply(body: unknown, init: { status?: number } = {}) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

/** Drive a promise to settlement, running any timers it waits on. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const result = promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const settled = await result;
  if (settled.ok) return settled.value;
  throw settled.error;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("ETHERSCAN_API_KEY", "test-key");
  clearCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("rate limiting", () => {
  it("retries a throttled response and succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(RATE_LIMITED))
      .mockResolvedValueOnce(reply(RATE_LIMITED))
      .mockResolvedValueOnce(reply(ONE_TX));

    const transactions = await settle(fetchTransactions(ADDRESS));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(transactions).toHaveLength(1);
  });

  it("treats an HTTP 429 the same as an in-body refusal", async () => {
    fetchMock
      .mockResolvedValueOnce(reply({}, { status: 429 }))
      .mockResolvedValueOnce(reply(ONE_TX));

    const transactions = await settle(fetchTransactions(ADDRESS));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(transactions).toHaveLength(1);
  });

  it("backs off further with each retry rather than hammering", async () => {
    fetchMock.mockResolvedValue(reply(RATE_LIMITED));
    const delays: number[] = [];
    const spy = vi.spyOn(globalThis, "setTimeout");

    await expect(settle(fetchTransactions(ADDRESS))).rejects.toThrow(EtherscanError);

    for (const call of spy.mock.calls) {
      const ms = call[1] ?? 0;
      if (ms >= 800) delays.push(ms); // ignore the short inter-request spacing
    }
    // 800, 1600, 3200, 6400 — each wait at least as long as the last.
    expect(delays.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
    spy.mockRestore();
  });

  it("gives up with an actionable message once retries run out", async () => {
    fetchMock.mockResolvedValue(reply(RATE_LIMITED));

    await expect(settle(fetchTransactions(ADDRESS))).rejects.toThrow(
      /rate limit after \d+ retries.*ETHERSCAN_MIN_SPACING_MS/,
    );
  });

  it("does not retry an error that is not a rate limit", async () => {
    fetchMock.mockResolvedValue(
      reply({ status: "0", message: "NOTOK", result: "Invalid API Key" }),
    );

    await expect(settle(fetchTransactions(ADDRESS))).rejects.toThrow(/Invalid API Key/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("caching", () => {
  it("serves a repeated lookup without calling the explorer again", async () => {
    fetchMock.mockResolvedValue(reply(ONE_TX));

    await settle(fetchTransactions(ADDRESS));
    await settle(fetchTransactions(ADDRESS));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches an empty history, which is a real answer", async () => {
    fetchMock.mockResolvedValue(
      reply({ status: "0", message: "No transactions found", result: [] }),
    );

    const first = await settle(fetchTransactions(ADDRESS));
    const second = await settle(fetchTransactions(ADDRESS));

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the API key out of the cache key", async () => {
    fetchMock.mockResolvedValue(reply(ONE_TX));
    await settle(fetchTransactions(ADDRESS));
    expect(String(fetchMock.mock.calls[0][0])).toContain("test-key");

    // The cache is module-private, so the claim is checked by its consequence:
    // rotate the key and the same address still hits the cached entry. That can
    // only happen if the key was stripped before the entry was keyed.
    vi.stubEnv("ETHERSCAN_API_KEY", "a-different-key");
    await settle(fetchTransactions(ADDRESS));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("api key", () => {
  it("fails clearly when the key is missing", async () => {
    vi.stubEnv("ETHERSCAN_API_KEY", "");
    await expect(settle(fetchTransactions(ADDRESS))).rejects.toThrow(/\.env\.local/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
