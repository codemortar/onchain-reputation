# onchain-reputation

Give it an Ethereum address or ENS name and it builds a developer profile from
public chain data: contracts deployed, whether the source was published, how
long and how consistently the address has been active. It scores that, shows how
the score breaks down, and lists what it can't tell you.

A learning project. I built it to spend some time with on-chain data, not to
rate anybody.

## The score

| Signal | Weight | Full marks at | Notes |
|---|---|---|---|
| Contracts deployed | 30% | 10 | Best evidence on chain that someone ships, not just transacts |
| Deployments with published source | 20% | — | Publishing source takes deliberate effort |
| Months with activity | 20% | 36 | Sustained presence, harder to fake than a transaction count |
| Account age | 15% | 5 years | Longevity |
| Distinct counterparties | 10% | 100 | A wallet that only ever talks to one contract looks automated |
| Transactions sent | 5% | 500 | Weighted lightly, since it's the easiest number here to inflate |

Counts are scaled logarithmically and capped, so a few enormous wallets don't
flatten everyone else into the bottom of the range.

A signal that can't be evaluated is skipped and its weight spread across the
others instead of being scored as zero. The verified-source ratio for an address
that never deployed anything is the obvious case.

The verified-source share only counts contracts that were actually checked. Past
the verification cap a deployment is marked unknown instead of unverified, since
"we didn't look" isn't the same as "they didn't publish". The profile says when
that happened.

Every component comes back with its raw value, normalised value, weight and
contribution, from both the API and the UI. So do the caveats: no deployments
found, activity concentrated on very few counterparties, dormant for years, too
little history to judge, truncated results, verification only sampled. Plus the
standing one, that an address proves control of a key and nothing about who
holds it.

## Stack

TypeScript, Next.js (App Router, server components), viem, Vitest.

Etherscan v2 supplies transaction history and source verification. A JSON-RPC
node via viem handles ENS in both directions. Both run server-side, so the API
key stays out of the browser.

### Rate limiting

Free Etherscan keys cap out around 3 requests a second, and a wallet with twenty
deployments needs twenty verification lookups, so requests go through a spacing
gate rather than firing in parallel. The default gap is 400ms; set
`ETHERSCAN_MIN_SPACING_MS` to change it. Responses are cached, oldest evicted
first.

Spacing on its own isn't enough. The ceiling varies by key, and a page can be
requested twice before the first render finishes, so a throttled response is
retried with exponential backoff. Each backoff also pushes the shared gate out,
which slows queued requests down together instead of letting them pile into the
same limit.

One thing that cost me an afternoon: the gate and the cache have to live on
`globalThis`, not at module scope. Next.js gives each bundling layer its own copy
of a module, so the page and the API route end up with separate gates, each
politely spacing its own requests while together blowing the limit. The symptom
is a correct-looking 400ms gap still collecting 3/sec refusals.

Even then it's only per-process. One long-lived server means one gate in front
of the key. On serverless each instance gets its own, so the key sees the total.

## Setup

```bash
npm install
cp .env.example .env.local     # add a free Etherscan API key
npm run dev                    # http://localhost:3000
```

```bash
npm test                       # 51 tests, no network
npm run build
```

There's a JSON endpoint too:

```
GET /api/profile?address=vitalik.eth
```

## Tests

Nothing hits the network. Fixtures are built so the expected answer is known up
front, and a captured Etherscan payload keeps the parser pinned to the real
response format. They run in about a second and don't break when an API is slow
or quietly changes shape.

If you want the design in one place, `src/lib/scoring.ts` has the weights and the
caveat rules, and `src/lib/activity.ts` has the counting decisions: why active
months beat transaction counts, why inbound transfers don't age an account, why
failed deployments don't count.

## Limitations

- Mainnet only. The explorer client takes a chain id, so other chains are mostly
  a config change.
- Etherscan returns at most 10,000 transactions per request, so counts for very
  busy addresses are a floor. The profile says when it hit that.
- Only the 25 most recent deployments get a source check. Each one is a separate
  serialised call, and an address with hundreds of them would otherwise spend
  minutes in the spacing gate. The rest are listed with unknown status.
- Contracts deployed by a factory don't show up, since only direct
  contract-creation transactions count.
- No sybil resistance. Given enough time and gas most of these signals can be
  manufactured. The weights make that more expensive, not impossible.
- It counts deployments, it doesn't read them. Nothing here judges code quality.
