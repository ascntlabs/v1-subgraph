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

### Deploying

This subgraph is deployed to The Graph (Subgraph Studio):

```bash
# one-time: deploy key from your subgraph's page at thegraph.com/studio
graph auth <DEPLOY_KEY>

yarn run deploy:studio <SUBGRAPH_SLUG> --version-label <VERSION_LABEL>
```

If the manifest contains a `graft:` block, it is applied by the deploy itself — the
base deployment ID must be a previous version of this subgraph so the indexer can
resolve it.

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
