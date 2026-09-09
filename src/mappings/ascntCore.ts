import { BigInt, ethereum, log, store } from '@graphprotocol/graph-ts'

import { Pool, PoolManager, Swap, SwapStaging } from '../types/schema'
import { SubgraphConfig } from '../utils/chains'
import { ONE_BI } from '../utils/constants'
import { loadTransaction } from '../utils/index'
import { updateDynamicFeeAggregates } from '../utils/intervalUpdates'

// Shared cores for the SimHookMVP and gov-version SimHook data sources. The two
// ABIs generate distinct event classes, but the params consumed here are
// identical (the gov version only dropped the unread timestamp fields), so the
// per-version handlers unpack their params and funnel into these.

const WAD = BigInt.fromString('1000000000000000000')

/** |estimated - real| * WAD / real; null if estimate missing or real is zero with non-zero estimate. */
export function priceImpactRelativeErrorWad(estimated: BigInt | null, real: BigInt): BigInt | null {
  if (estimated === null) {
    return null
  }
  if (real.equals(BigInt.zero())) {
    return estimated.equals(BigInt.zero()) ? BigInt.zero() : null
  }
  const diff = estimated.gt(real) ? estimated.minus(real) : real.minus(estimated)
  return diff.times(WAD).div(real)
}

export function ascntBeforeSwapCore(
  event: ethereum.Event,
  poolId: string,
  sqrtPriceX96Before: BigInt,
  priceImpact: BigInt,
  decayedCumPriceImpact: BigInt,
  dynamicFeePips: BigInt,
): void {
  const pool = Pool.load(poolId)

  if (!pool) {
    log.warning('Pool not found: {}', [poolId])
    return
  }

  // BeforeSwap.priceImpact is the pre-swap simulated impact — map it onto
  // estimatedPriceImpact so the estimated-vs-real error metric keeps working.
  pool.sqrtPriceX96Before = sqrtPriceX96Before
  pool.estimatedPriceImpact = priceImpact
  pool.decayedCumPriceImpact = decayedCumPriceImpact
  pool.dynamicFeePips = dynamicFeePips

  // create Swap Staging event
  const transaction = loadTransaction(event)
  const swapStaging = new SwapStaging(transaction.id + '-' + pool.id.toString())
  swapStaging.transaction = transaction.id
  swapStaging.pool = pool.id
  swapStaging.sqrtPriceX96Before = sqrtPriceX96Before
  swapStaging.estimatedPriceImpact = priceImpact
  swapStaging.decayedCumPriceImpact = decayedCumPriceImpact
  swapStaging.dynamicFeePips = dynamicFeePips

  pool.save()
  swapStaging.save()
}

export function ascntAfterSwapCore(
  event: ethereum.Event,
  poolId: string,
  realPriceImpact: BigInt,
  cumPriceImpact: BigInt,
): void {
  const pool = Pool.load(poolId)

  if (!pool) {
    log.warning('Pool not found: {}', [poolId])
    return
  }

  // pair with previous Swap Event
  const transaction = loadTransaction(event)
  const swapStagingId = transaction.id + '-' + poolId
  const swapStaging = SwapStaging.load(swapStagingId)

  if (!swapStaging) {
    log.warning('SwapStaging not found: {}', [swapStagingId])
    return
  }

  if (swapStaging.swapId === null) {
    log.warning('SwapStaging missing swapId: {}', [swapStagingId])
    return
  }
  const swapId = swapStaging.swapId as string
  const swap = Swap.load(swapId)

  if (!swap) {
    log.warning('Swap not found: {}', [swapId])
    return
  }

  store.remove('SwapStaging', swapStagingId)

  const priceImpactError = priceImpactRelativeErrorWad(swap.estimatedPriceImpact, realPriceImpact)

  swap.priceImpact = realPriceImpact
  swap.cumPriceImpact = cumPriceImpact
  swap.priceImpactError = priceImpactError

  pool.priceImpact = realPriceImpact
  pool.cumPriceImpact = cumPriceImpact
  pool.priceImpactError = priceImpactError

  swap.save()
  pool.save()

  // Roll the per-period dynamic-fee aggregates. dynamicFeePips was merged onto
  // the Swap entity by handleSwap from SwapStaging — it should be set for any
  // Ascnt-pool swap, but guard defensively.
  const fee = swap.dynamicFeePips
  if (fee !== null) {
    updateDynamicFeeAggregates(poolId, event.block.timestamp.toI32(), fee as BigInt, swap.id)
  }
}

export function ascntInitializedCore(poolId: string, subgraphConfig: SubgraphConfig): void {
  const poolManagerAddress = subgraphConfig.poolManagerAddress
  const poolsToSkip = subgraphConfig.poolsToSkip

  if (poolsToSkip.includes(poolId)) {
    return
  }

  const pool = Pool.load(poolId)

  if (!pool) {
    log.warning('Pool not found: {}', [poolId])
    return
  }

  if (pool.isAscntPool) return

  pool.isAscntPool = true
  pool.save()

  const poolManager = PoolManager.load(poolManagerAddress)!
  const ascntPools = poolManager.ascntPools
  ascntPools.push(poolId)
  poolManager.ascntPools = ascntPools
  poolManager.ascntPoolCount = poolManager.ascntPoolCount.plus(ONE_BI)
  poolManager.save()
}
