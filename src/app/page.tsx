/**
 * Single-page profile lookup.
 *
 * A server component reading the query string, so the form needs no client-side
 * JavaScript and the explorer API key never leaves the server.
 */

import { EtherscanError } from "@/lib/etherscan";
import { InvalidAddressError, getProfile } from "@/lib/profile";
import type { Profile } from "@/lib/types";

export const dynamic = "force-dynamic";

function ScoreDial({ score }: { score: number }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-6xl font-bold tabular-nums">{Math.round(score * 100)}</span>
      <span className="text-2xl text-neutral-500">/ 100</span>
    </div>
  );
}

function Bar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800">
      <div
        className="h-full rounded bg-neutral-800 dark:bg-neutral-200"
        style={{ width: `${Math.round(value * 100)}%` }}
      />
    </div>
  );
}

function formatRaw(key: string, raw: number): string {
  if (key === "verifiedRatio") return `${Math.round(raw * 100)}%`;
  if (key === "accountAge") return `${raw.toLocaleString()} days`;
  return raw.toLocaleString();
}

function ProfileView({ profile }: { profile: Profile }) {
  const { summary, components, caveats, score } = profile;
  return (
    <div className="space-y-10">
      <section className="space-y-2">
        <ScoreDial score={score} />
        <p className="font-mono text-sm break-all text-neutral-600 dark:text-neutral-400">
          {summary.ensName ? `${summary.ensName} — ` : ""}
          {summary.address}
        </p>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {summary.deployments.length} contract
          {summary.deployments.length === 1 ? "" : "s"} deployed ·{" "}
          {summary.txCount.toLocaleString()} transactions · {summary.activeMonths} active
          month{summary.activeMonths === 1 ? "" : "s"}
          {summary.firstSeen
            ? ` · first seen ${summary.firstSeen.toISOString().slice(0, 10)}`
            : ""}
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
          How the score is made up
        </h2>
        <ul className="space-y-4">
          {components.map((c) => (
            <li key={c.key} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-4 text-sm">
                <span className="font-medium">{c.label}</span>
                <span className="tabular-nums text-neutral-500">
                  {formatRaw(c.key, c.raw)} · weight {Math.round(c.weight * 100)}% ·
                  contributes {(c.contribution * 100).toFixed(1)}
                </span>
              </div>
              <Bar value={c.normalised} />
              <p className="text-xs text-neutral-500">{c.explanation}</p>
            </li>
          ))}
        </ul>
      </section>

      {summary.deployments.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
            Deployments
          </h2>
          <ul className="space-y-1.5 font-mono text-xs">
            {summary.deployments.map((d) => (
              <li key={d.address} className="flex flex-wrap gap-x-3 gap-y-1">
                <span className="break-all">{d.address}</span>
                <span className="text-neutral-500">
                  {d.deployedAt.toISOString().slice(0, 10)}
                </span>
                <span
                  className={
                    d.verified ? "text-green-700 dark:text-green-500" : "text-neutral-500"
                  }
                >
                  {d.verified === null
                    ? "source not checked"
                    : d.verified
                      ? `verified${d.name ? ` · ${d.name}` : ""}`
                      : "source not published"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
          What this score cannot tell you
        </h2>
        <ul className="space-y-2 text-sm text-neutral-600 dark:text-neutral-400">
          {caveats.map((c) => (
            <li key={c.key} className="flex gap-2">
              <span aria-hidden className="select-none">
                •
              </span>
              <span>{c.message}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

async function Result({ address }: { address: string }) {
  let profile: Profile;
  try {
    profile = await getProfile(address);
  } catch (error) {
    // Our own error types are written for the reader and safe to show. Anything
    // else may carry internals such as the configured RPC URL, so it goes to
    // the log and the page gets a generic line.
    let message = "Something went wrong looking up this address.";
    if (error instanceof InvalidAddressError || error instanceof EtherscanError) {
      message = error.message;
    } else {
      console.error("Unexpected error building profile:", error);
    }
    return (
      <p className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        {message}
      </p>
    );
  }
  return <ProfileView profile={profile} />;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ address?: string }>;
}) {
  const { address } = await searchParams;

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <header className="space-y-3">
        <h1 className="text-2xl font-bold">On-chain reputation</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Builds a structured developer profile from public Ethereum activity:
          contracts deployed, whether their source was published, and how sustained
          the address has been. Every part of the score is shown, and so is what it
          cannot prove.
        </p>
      </header>

      <form className="mt-8 flex gap-2" action="/">
        <input
          name="address"
          defaultValue={address ?? ""}
          placeholder="0x… or vitalik.eth"
          aria-label="Ethereum address or ENS name"
          className="flex-1 rounded border border-neutral-300 bg-transparent px-3 py-2 font-mono text-sm dark:border-neutral-700"
        />
        <button
          type="submit"
          className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
        >
          Look up
        </button>
      </form>

      <div className="mt-12">
        {address ? (
          <Result address={address} />
        ) : (
          <p className="text-sm text-neutral-500">
            Enter an address to see its profile. A learning project, not a verdict on
            anybody.
          </p>
        )}
      </div>
    </main>
  );
}
