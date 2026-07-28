# onchain-reputation

Builds a structured developer profile from public Ethereum activity. Give it an
address or an ENS name and it reports what the chain can actually evidence:
contracts deployed, whether their source was published, how long and how
consistently the address has been active — then scores it, shows every component
of that score, and states plainly what the number cannot prove.

A learning project. I wrote it to get hands-on with on-chain data rather than to
pass judgement on anybody.

## Why it looks like this

Reputation scoring is easy to do badly. The tempting version produces one
confident number from opaque weights, and nobody — least of all the person being
scored — can tell whether it means anything. So two rules shaped the design:

**Every score comes apart.** Each signal is normalised by a documented curve and
combined with a fixed, visible weight. The API and the UI both return each
component's raw value, its normalised value, its weight and its contribution.
A score you cannot interrogate is worse than no score.

**The limits are output, not footnotes.** The profile returns caveats alongside
the score: no deployments found, activity concentrated on a handful of
counterparties (the shape of a bot), dormant for years, too little history to
judge, explorer results truncated. And always: an address is not a person — it
proves control of a key, not authorship.

## Signals and weights

| Signal | Weight | Full marks at | Why |
|---|---|---|---|
| Contracts deployed | 30% | 10 | Clearest evidence someone ships, not just transacts |
| Deployments with published source | 20% | — | Publishing source is deliberate; proxy for work meant to be used |
| Months with activity | 20% | 36 | Sustained presence, much harder to fake than a transaction count |
| Account age | 15% | 5 years | Longevity |
| Distinct counterparties | 10% | 100 | Breadth; a wallet with one counterparty looks automated |
| Transactions sent | 5% | 500 | Weighted lightly — the easiest signal to inflate |

Counts are scaled logarithmically and capped, so a handful of enormous wallets
cannot flatten everyone else into the bottom of the range. A signal that cannot
be evaluated (the verified-source ratio for an address that has deployed
nothing) is skipped and its weight redistributed, rather than scored as zero.

## Stack

TypeScript, Next.js (App Router, server components), viem, Vitest.

The Etherscan v2 API supplies transaction history and source verification; a
JSON-RPC node via viem handles ENS in both directions. Both run server-side
only, so the API key never reaches a browser. Requests are serialised through a
spacing gate to stay inside the free tier's rate limit — checking a wallet with
twenty deployments means twenty verification lookups — and responses are cached
in-process.

## Setup

```bash
npm install
cp .env.example .env.local     # add a free Etherscan API key
npm run dev                    # http://localhost:3000
```

```bash
npm test                       # 33 tests, no network
npm run build
```

There is also a JSON endpoint:

```
GET /api/profile?address=vitalik.eth
```

## Tests

The tests never touch the network. Fixtures are built so the right answer is
known by construction — a captured Etherscan payload pins the parsing to the
real response format, and the counting rules are checked against hand-built
histories. That means they run offline in about a second and cannot fail because
an API is slow, throttled, or has quietly changed shape.

Worth reading if you want the design in one place: `src/lib/scoring.ts` holds
the weights and the caveat rules, `src/lib/activity.ts` the counting decisions
(why active *months* beat transaction counts, why inbound transfers don't age an
account, why failed deployments don't count).

## Known limitations

- **Ethereum mainnet only.** One chain done properly rather than five done
  loosely. The explorer client is already parameterised by chain id.
- **Explorer page cap.** Etherscan returns at most 10,000 transactions per
  request, so for very busy addresses the counts are a floor. The profile says
  so when it happens rather than quietly under-reporting.
- **Deployments via a factory are missed.** Only direct contract-creation
  transactions are counted; contracts deployed by another contract on the
  address's behalf do not appear as creations from that address.
- **No sybil resistance.** Anyone willing to spend gas over a long enough period
  can manufacture most of these signals. The weights make that more expensive,
  not impossible.
- **A score is not a judgement of quality.** It counts deployments; it does not
  read the code in them.
