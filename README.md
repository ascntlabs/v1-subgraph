# Ascnt Subgraph

Indexes Ascnt's custom-fee hooks on Uniswap v4 (mainnet). Forked from
[Uniswap/v4-subgraph](https://github.com/Uniswap/v4-subgraph), GPL-3.0-or-later.

### Running Unit Tests

1. Install [Docker](https://docs.docker.com/get-docker/) if you don't have it already
2. Install postgres: `brew install postgresql`
3. `yarn run build:docker`
4. `yarn run test`

### Adding New Chains

1. Create a new subgraph config in `src/utils/chains.ts`. This will require adding a new `<NETWORK_NAME>_NETWORK_NAME` const for the corresponding network.
2. Add a new entry in `networks.json` for the new chain. The network name should be derived from the CLI Name in The Graph's [supported networks documenation](https://thegraph.com/docs/en/developing/supported-networks/). The factory address can be derived from Uniswap's deployments documentation (not yet available).

### Deploying the The Graph (Subgraph Studio)

```bash
# one-time: deploy key from your subgraph's page at thegraph.com/studio
graph auth <DEPLOY_KEY>

yarn run deploy:studio <SUBGRAPH_SLUG> --version-label <VERSION_LABEL>
```

If the manifest contains a `graft:` block, it is applied by the deploy itself — the
base deployment ID must be a previous version of this subgraph so the indexer can
resolve it.

#### Publishing to The Graph Network

```bash
# build, upload the manifest to IPFS and publish it as a new version of the
# existing subgraph (opens https://cli.thegraph.com/publish to sign)
graph publish --subgraph-id <SUBGRAPH_ID> --api-key <GRAPH_API_KEY>

# if the manifest is already on IPFS (e.g. a graft that Studio rejected after
# `graph deploy` had uploaded it), publish that hash directly
graph publish --subgraph-id <SUBGRAPH_ID> --api-key <GRAPH_API_KEY> --ipfs-hash <Qm...>
```

- `<SUBGRAPH_ID>` is the network subgraph ID (base58) from the subgraph's Graph
  Explorer page. Omitting it creates a brand-new subgraph instead of a new version.
- `<GRAPH_API_KEY>` is a network API key (Studio → API Keys, the same kind used for
  gateway queries). The CLI refuses to publish to an existing subgraph without it and
  hands it to the browser page so it can load the subgraph.
- Curation signal migrates to the new version by default, so the old version keeps
  being served only until indexers close their allocations. Pin the frontend to the
  old deployment ID while the new one syncs, and check
  `_meta { block { number } hasIndexingErrors }` on the new deployment ID before
  switching.
- A grafted manifest can only be published this way (Studio has no base). It syncs
  only on indexers that already hold the base past the graft block.

Query URLs: `https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>`
follows the latest version; `https://gateway.thegraph.com/api/<API_KEY>/deployments/id/<Qm...>`
pins one deployment.

#### 1.0.0 release (gov-version hooks): graft rules

- The manifest grafts onto v0.0.3's deployment (`QmXHVm…8iF2`). The graft `block`
  is 25913295, the last block before the governance/factory deploy, so every
  governance, factory and hook event is replayed from the new contracts' genesis
  and the live SimHook is discovered through `HookDeployed` like any future hook.
- Studio only keeps a near-head window of entity history and rejects an older
  graft block. If it does, do not simply raise the block: the factory event would
  then never be replayed. Switch to the fallback branch `feat/1.0.0-graft-fallback`,
  which adds a static data source for the live hook and bootstraps Hook/Protocol
  state from contract reads.
- Deploy **before** the first Ascnt pool is initialised; pools initialised before
  the graft block would never be marked as Ascnt pools.

#### Subscriber removal (`isAscntPool` sync): graft notes

- `SubscriberRemoved` clears `isAscntPool` on the removed hook's pools, drops them
  from `PoolManager.ascntPools` and stops the Ascnt swap overlay for them from that
  block on. `Pool.ascntRemovedAtBlock` and `Hook.subscriberRemovedAtBlock` record
  when. Uniswap-level swap and liquidity data for the pool keeps indexing.
- The schema change is nullable fields only, so this version can graft. Two valid
  bases: v1.0.0 (`QmNcUa…8nti`) at a near-head block, which is only correct if no
  `SubscriberRemoved` fired before that block (a removal before the graft block
  would leave its pools flagged forever); or v0.0.3 at 25913295 again, which
  replays every governance event through the new handler but needs an indexer
  that still holds v0.0.3 history at that block.
- Verify before choosing: query `hooks(where: {isSubscriber: false})` on v1.0.0.
  Any row with a non-zero `factory` was registered at deploy and later removed.

#### Fee/TVL accounting fix: full resync

- `feeTier`, `lpFeesUSD` and the `totalValueLocked*` fields are stored accumulators,
  so the `handleSwap` fix in this version cannot be grafted onto a deployment that
  indexed with the old handler: history would keep the drift and only new blocks
  would be right. The manifest carries no `graft` block; deploy it as a full sync
  from the PoolManager start block (21688329).
- Keep the frontend pinned to the previous deployment ID until the new one reports
  `_meta { block { number } }` at head, then move the pin. The Robinhood manifest
  needs the same full redeploy (`ROBINHOOD_SUBGRAPH_URL` is version-pinned).
- Before publishing, run `python3 scripts/acceptance.py --url <synced endpoint>`
  (standard library only). It checks the synced data against independent oracles:
  TVL against a walk of the pool's own ticks, pricing against a replay of
  `findNativePerToken` at the latest swap's block, hour-bucket fees against the
  rates, the legacy hook set, the whitelist additions, the `ModifyLiquidity`
  snapshot and each `Position` against its own snapshots. `--no-legacy` for
  Robinhood.
- The same resync backfills the `Position` state and `PositionSnapshot` history
  (see "Positions"). They are per-event accumulators, so a graft could only have
  started them at the graft block.
- This resync is also the moment for the deferred cleanup that needs one: healing
  OHLC history. The two legacy hook data sources stay (see "Legacy hooks").

### Robinhood Chain

Robinhood Chain (CLI name `robinhood`, chain ID 4663, Arbitrum Orbit L2, ETH gas)
has its own manifest, `subgraph.robinhood.yaml`.

> **The Graph cannot host this subgraph.**

It is kept separate from `subgraph.yaml` rather than switched with `--network`
because the two differ in more than addresses:

- **No `graft:` block and no `grafting` feature.** A graft only resolves against a
  previous deployment of this subgraph on the same network, and there is none on
  Robinhood. This is a clean-slate sync.
- **No `SimHookMVPLegacy` / `CumHookMVPLegacy` data sources.** Those are Ethereum
  mainnet MVP contracts and do not exist on Robinhood. The live hook is discovered
  through `HookDeployed` and the `SimHook` template, as on mainnet.

Could only be merged into one `subgraph.yaml` if the legacy hook data sources were
retired; they stay (see "Legacy hooks").

#### Deploying Robinhood (Goldsky)

Goldsky runs graph-node against Robinhood Chain and accepts a standard subgraph
manifest, so this one deploys unmodified.

```bash
# one-time setup
curl https://goldsky.com | sh          # or: npm install -g @goldskycom/cli
goldsky login                          # or: goldsky login --token <API_KEY> in CI

# every deploy
yarn build:robinhood
yarn deploy:goldsky ascnt-robinhood/<VERSION>
goldsky subgraph list                  # watch the backfill
```

`build:robinhood` writes to `build/robinhood/` deliberately. `goldsky subgraph deploy` takes `--path <directory>` and has **no flag for choosing a manifest
filename**, so pointing it at the repo root would deploy `subgraph.yaml` — the
mainnet manifest, graft and all. Deploying out of the build directory is what keeps
the two apart.

#### Network slug

Goldsky indexes this chain as **`robinhood-mainnet`** — matching the
`<chain>-mainnet` convention used elsewhere in `networks.json`. The Graph's networks
registry calls it `robinhood` instead, and its published docs table is wrong about
both the slug and about Subgraphs being available at all.

`dataSource.network()` returns whatever the manifest says, so `getSubgraphConfig()`
matches both spellings and the same mappings work on either host without an edit.
**All `network:` lines in a manifest must agree** — a mixed manifest is rejected at
deploy, and the build output is what ships, so rebuild after changing them.

`build:robinhood` runs `codegen` against `subgraph.yaml` on purpose: it is the
superset manifest and every manifest shares the generated types in `src/types/`.
Running codegen against the Robinhood manifest would drop the legacy hook types and
break the mainnet build.

<details>
<summary>Deploying to Alchemy instead (upstream flow, unused)</summary>

```
yarn run deploy:alchemy --
  <SUBGRAPH_NAME>
  --version-label <VERSION_LABEL>
  --deploy-key <DEPLOYMENT_KEY>
  --network <NETWORK_NAME>
```

</details>

## Pool fee and TVL semantics

Uniswap v4 charges its protocol fee on top of the LP fee, and `Swap.fee` is the
combined rate the swapper paid on its gross input
(`ProtocolFeeLibrary.calculateSwapFee`: `protocolFee + lpFee - floor(protocolFee * lpFee / 1e6)`).
Upstream's v4-subgraph copies that value into `feeTier`, bills fees on it and adds
the gross swap input to TVL. This subgraph departs from upstream as follows.

- `Pool.feeTier` is the pool key's fee from `Initialize` and never changes: the
  static tier, or the dynamic-fee flag `8388608` on dynamic pools, so a `PoolKey`
  built from it hashes to the pool.
- `Pool.poolFee` is the rate the pool charged on the last swap before Uniswap's
  cut. Static pools: the tier. Ascnt pools: the dynamic fee the hook chose, which
  is the LP share plus Ascnt's cut (the same number as `dynamicFeePips`). Other
  dynamic-fee pools: the LP fee of the last swap, recovered from `Swap.fee` and the
  input side's Uniswap rate (`lpFeeFromSwapFee` in `src/utils/fees.ts`; where two
  neighbouring LP fees map to the same `Swap.fee` because of the floor, the larger
  is taken). Dynamic pools hold 0 here, in `lpFee` and in `totalSwapFee` until
  their first swap; static pools hold the tier from the start.
- `Pool.lpFee` is the LP revenue rate of the last swap: `poolFee` minus Ascnt's
  cut, so equal to `poolFee` off Ascnt pools. `Pool.ascntProtocolFee` is that cut,
  `poolFee - lpFee`. Both come from the swap's own events, never from the hook's
  cached bps: the hook lowers its LP fee override to `lpFee` before the swap and
  takes the cut in `afterSwap` as a hook delta on the unspecified currency, so the
  cut is never inside `Swap.fee`. The governance share behind the cut, in bps of
  the pool fee, is `Hook.cachedProtocolFeeBps`.
- `Pool.uniswapProtocolFeeZeroForOne` / `uniswapProtocolFeeOneForZero`: Uniswap's
  protocol fee per swap direction, in pips, from `PoolManager.ProtocolFeeUpdated`
  (packed uint24, zeroForOne in the low 12 bits). Pools start at 0.
- `Pool.totalSwapFee` is everything the swapper paid on the last swap:
  `poolFee + uniswapProtocolFee` of that direction. It is not `Swap.fee` on Ascnt
  pools, for the reason above. Uniswap composes its rate as
  `protocolFee + lpFee - floor(protocolFee * lpFee / 1e6)` and Ascnt's cut lands on
  the output side of an exact-input swap, so the true all-in is a hair under this
  plain sum; the sum is the number to show.
- Every `Swap` carries the same five rates for that swap: `poolFee`, `lpFee`,
  `ascntProtocolFee`, `uniswapProtocolFee`, `totalSwapFee`.
- Fee amounts are split by who receives them, in USD and per token:
  - `lpFeesUSD` on pools, tokens and their day/hour buckets, and
    `PoolManager.totalLpFeesUSD/ETH`: tracked volume x
    `(Swap.fee - uniswapProtocolFee) / 1e6`, exactly the share `Pool.swap` credits
    to `feeGrowthGlobal`. `Pool.lpFeesToken0/1` hold the same fee on the input token
    of each swap, in decimal units.
  - `Pool.uniswapProtocolFeesUSD` and `uniswapProtocolFeesToken0/1`: Uniswap's cut,
    tracked volume (or the input amount) x its rate. Also on pool day/hour buckets.
  - `Pool.ascntProtocolFeesToken0/1` and `ascntProtocolFeesUSD`: Ascnt's cut, from
    the hook's `ProtocolFeeTaken` / `ProtocolFeeTakenAsClaims` amounts, in decimal
    units and valued at the moment of the take. Also on pool day/hour buckets.
  - There is no stored grand total; it is the sum of the three. Upstream's
    `feesUSD` and the never-written `collectedFees*` fields are gone, so a stale
    query fails instead of reading a redefined number. The computed token amounts
    are exact up to one wei of rounding per tick step.
- `Pool.totalValueLockedToken0/1` and `Token.totalValueLocked` are the reserves
  that back liquidity: what integrating `Tick.liquidityNet` against `sqrtPrice`
  gives, and what Uniswap's UI shows. Fees never enter them. A swap adds
  `input x (1 - Swap.fee / 1e6)` and subtracts the output in full; `ModifyLiquidity`
  adds or removes the position's amounts at the current price (the same rounding
  as `Pool.modifyLiquidity`). Nothing else is possible from events: v4 has no
  `Collect` event, LP fees are paid out silently on every `ModifyLiquidity` (any
  `liquidityDelta`, amounts not emitted) and protocol fees leave through
  `collectProtocolFees` with no pool-level event. Counting fees in with nothing to
  count them out made TVL drift upward by every fee ever charged. What remains is
  per-step rounding dust, a wei per swap step, always in the pool's favour.
  `Donate` is not tracked on either side.
- `Hook.cachedProtocolFeeBps` is seeded at `HookDeployed` with the governance
  `protocolFeeBps` of the moment, read through the factory's `governance()`, because
  `AscntBaseHook`'s constructor copies that value without emitting
  `ProtocolFeeBpsCached`. Every later push overwrites it. The Ascnt cut itself is
  never derived from this field: it is `poolFee - lpFee`, both taken from the
  swap's own events.

## Token pricing

`Token.derivedETH` is the token's price in the chain's native token, and every USD
figure is `derivedETH x Bundle.ethPriceUSD`. ETH and WETH are 1; the chain config's
`stablecoinAddresses` are pinned to `1 / ethPriceUSD`; every other token is priced
from its `whitelistPools` (pools pairing it with a `whitelistTokens` entry) by
`findNativePerToken` in `src/utils/pricing.ts`, which departs from upstream in
three ways.

- The floor is in USD. A pool qualifies when it has in-range liquidity and twice
  its whitelisted leg, valued at the bundle's native price when the check runs,
  exceeds `minimumUSDLocked` (1000 on mainnet and Robinhood). The leg stands in for
  half the pool, as tracked volume does. Upstream required the leg alone to hold 1
  ETH, which a \$750 USDC leg never clears whatever the pool is worth.
- Fresh pools win. Among qualifying pools, the largest one swapped in the last 24
  hours (`Pool.lastSwapTimestamp`) prices the token; only when none is fresh does
  the largest overall. Upstream took the largest regardless, so a deep pool that
  had gone quiet held a token at its last price while a smaller pool traded it
  every hour.
- No one-swap lag. `handleSwap` saves the pool before pricing, so when the swapped
  pool is the ETH/USD pool or a token's pricing pool, the price read is this
  swap's and not the previous one's. Upstream prices from the store before saving.

A token priced through a stablecoin pool is exact at each swap in that pool and
drifts with ETH between swaps, because the stored price is in ETH. That is
inherent to the native-denominated design and is not changed here.

Mainnet additions to `whitelistTokens` over upstream: EURC, COW, PAXG, XAUT, ZCHF,
UNI, MORPHO, IEFon, IEIon; FEI removed; TUSD dropped from `stablecoinAddresses`. A
whitelisted token is still priced from a pool against an already-priced token, so
two newly listed tokens cannot price each other through their own pair.

Smaller departures in the same area: `TokenDayData.untrackedVolumeUSD` and
`TokenHourData.untrackedVolumeUSD` receive the untracked amount (upstream adds the
tracked one, so the two bucket figures were always identical); `ModifyLiquidity`
records the pool's `sqrtPrice` and `tick` at event time, and its `amount`,
`amount0`, `amount1` and `amountUSD` are all signed the same way, positive for
adds and negative for removes.

## Legacy hooks

Seven Ascnt hooks predate the HookFactory and governance contracts: the five
price-impact hooks (Simple Price Impact, Cum PI, Cum PI 400bps, Cum PI 1-day,
Cum PI 1-hour), Div Hook MVP (`CumHookMVPLegacy`) and Sim Hook MVP
(`SimHookMVPLegacy`). None emitted `HookDeployed`, so the factory can never attest
them and there was no `Hook` entity to read a status from; the frontends carried a
hard-coded blacklist instead. The subgraph now owns that list as
`legacyHookAddresses` in the chain config (`src/utils/chains.ts`; mainnet only,
empty on Robinhood):

- The first `Initialize` on a listed hook creates its `Hook` entity with
  `deprecated: true`, `legacy: true`, zeroed `salt` / `factory`, and `createdAt*`
  set to that first pool rather than the hook's deploy.
- Every pool on a listed hook is an Ascnt pool from `Initialize` (`isAscntPool`,
  `PoolManager.ascntPools`), so lifetime volume and fees on all seven keep
  counting toward the protocol totals. Before this only the two hooks with a data
  source were flagged, by their own `PoolInitialized`; that handler still runs and
  is now a no-op for them. The five without a data source get the flag and the
  Uniswap-level data only: no hook events are indexed, so no swap overlay.
- `Pool.hook` links a pool to its `Hook` entity whenever the subgraph has one
  (factory-deployed or legacy) and is null for hookless and third-party pools, so
  `pool { hook { deprecated legacy addLiquidityPaused } }` is the one status read a
  frontend needs. `Hook.pools` is the reverse lookup.

The two legacy data sources stay in `subgraph.yaml`: they give those pools their
dynamic-fee history (the overlay fields), and nothing depends on removing them.

## Positions

`Position` rows exist for PositionManager NFTs only, created at the ERC-721
`Transfer` that mints them. Upstream's v4-subgraph stops there: pool, range and
balances come from contract reads, and the history is the raw `modifyLiquiditys`
list. This subgraph folds every PositionManager-routed `ModifyLiquidity` (sender is
the PositionManager, salt is `bytes32(tokenId)`) into the position
(`src/utils/position.ts`):

- `Position.pool`, `tickLower`, `tickUpper`, `mintSqrtPrice`, `mintTick` are set by
  the first event (the mint) and never change. They are null for the one log
  between the NFT transfer and that event. `Pool.positions` is the reverse lookup.
- `Position.liquidity` is the running sum of `ModifyLiquidity.amount`;
  `modifyCount` the number of events, zero-delta fee collections included.
- `depositedToken0/1`, `depositedUSD`, `depositedETH` sum the principal of positive
  deltas; the `withdrawn*` fields the principal of negative ones, as positive
  numbers. `deposited - withdrawn` is the net principal in each denomination and
  `depositedUSD - withdrawnUSD` the net cost basis. USD and ETH are valued at each
  event's own prices, so no hour-bucket price lookup is needed.
- `lastModifiedTimestamp` is the latest event. `closedAtTimestamp` is set by the
  removal that takes liquidity to 0 and cleared when liquidity is added again.
- One immutable `PositionSnapshot` per event, id `tokenId#modifyCount`: the event's
  delta and amounts, the position's liquidity and accumulators after it, the pool's
  `sqrtPrice` / `tick`, the owner, and the prices used (`ethPriceUSD`,
  `token0DerivedETH`, `token1DerivedETH`). `Position.snapshots` lists them; the
  leg between two snapshots is the capital the earlier one records, for the time
  between them.

Everything above is principal. v4 emits no fee amounts: the fees a modify pays
out are in the call's return value and in no log, so they appear in none of these
fields, and the net of the flows of a closed position is price divergence, not
fees. What a frontend can read off a closed position is its realised principal
PnL; fees come from elsewhere (below). Positions opened directly against the
PoolManager, with arbitrary salts, have no `Position` row at all.

### Lifetime fees: deferred

Realised fees need contract state, not events. The plan, for when closed-position
fee history or protocol-wide LP fee totals are wanted:

- In the `ModifyLiquidity` handler, for PositionManager-routed events (optionally
  only on Ascnt pools), read the position's own storage through the PoolManager's
  `extsload(bytes32,uint256)`: the three slots v4-core's `StateLibrary` reads in
  `getPositionInfo`, derived from the pool id and
  `keccak256(owner . tickLower . tickUpper . salt)` with `owner` the
  PositionManager: `liquidity`, `feeGrowthInside0LastX128`,
  `feeGrowthInside1LastX128`. One `eth_call` per event, at the end of the event's
  block.
- Keep the two `last` values on the position and accumulate
  `collectedFeesToken0/1 += liquidityBefore x (last_k - last_k-1) / 2^128`, with
  the subtraction modulo 2^256. Uncollected fees stay a live read: nothing in the
  events moves them.
- Read the position's stored values, not `getFeeGrowthInside` for the range. A
  removal that empties a tick clears it, after which the range-level figure no
  longer equals what the position was credited; the stored values survive at zero
  liquidity. The app's `reconstructLifetime.ts` has this hole for
  close-then-reopen positions.
- Measure before shipping: sync a second throwaway deployment against the
  current one's rate. A graft only covers positions minted after the graft block;
  older ones need a full resync or the app's archive fallback.
- The zero-call alternative for new pools is a hook version with
  `afterRemoveLiquidity` on that emits `feesAccrued` per modify
  (`afterAddLiquidity` already runs). Permission bits are part of the hook
  address, so it covers pools on the new hook only.

## Generating subgraph.yaml

> **Warning:** `generate-subgraph` only templates the PoolManager and PositionManager
> data sources. Running it will silently DROP the SimHookMVPLegacy / CumHookMVPLegacy
> data sources and the `graft:` block from `subgraph.yaml`. Do not use it for mainnet
> until the script is taught about the hook data sources.

The `subgraph.yaml` file can be automatically generated from the `networks.json` configuration for a specific network. This ensures that all contract addresses and start blocks are correctly synchronized.

To generate the subgraph.yaml:

1. Make sure your `networks.json` is up to date with the correct contract addresses and start blocks
2. Run:
   ```bash
   yarn generate-subgraph <network>
   ```
   For example:
   ```bash
   yarn generate-subgraph mainnet
   # or
   yarn generate-subgraph arbitrum-one
   ```

This will create a new `subgraph.yaml` file based on the network-specific configuration. The script will:

- Use the contract templates defined for each contract type (PoolManager, PositionManager, etc.)
- Generate data sources for each contract in the specified network
- Preserve all the necessary event handlers and ABI configurations

Available networks can be found in `networks.json`.
