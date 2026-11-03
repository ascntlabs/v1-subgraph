import { BigInt, log, store } from '@graphprotocol/graph-ts'

import {
  AfterSwap as AscntAfterSwapLegacyEvent,
  BeforeSwap as AscntBeforeSwapLegacyEvent,
  PoolConfigured as AscntConfiguredLegacyEvent,
  PoolInitialized as AscntInitializedLegacyEvent,
} from '../types/CumHookMVPLegacy/CumHookMVPLegacy'
import { Pool, PoolManager, Swap, SwapStaging } from '../types/schema'
import { getSubgraphConfig, SubgraphConfig } from '../utils/chains'
import { ONE_BI } from '../utils/constants'
import { loadTransaction } from '../utils/index'
import { updateDynamicFeeAggregates } from '../utils/intervalUpdates'
import { priceImpactRelativeErrorWad } from './ascntAfterSwap'

// Compatibility shim for the pre-SimHookMVP hook deployment (0x29d6…B0C0):
// identical logic to the original handlers, decoding the old event shapes so
// the old hook keeps collecting data alongside the new one.

export function handleAscntInitializedLegacy(event: AscntInitializedLegacyEvent): void {
  handleAscntInitializedLegacyHelper(event)
}

export function handleAscntInitializedLegacyHelper(
  event: AscntInitializedLegacyEvent,
  subgraphConfig: SubgraphConfig = getSubgraphConfig(),
): void {
  const poolManagerAddress = subgraphConfig.poolManagerAddress
  const poolsToSkip = subgraphConfig.poolsToSkip
  const poolId = event.params.id.toHexString()

  if (poolsToSkip.includes(poolId)) {
    return
  }

  const pool = Pool.load(poolId)

  if (!pool) {
    log.warning('Pool not found: {}', [poolId])
    return
  }

  // handleInitialize already flags pools on a hook listed in legacyHookAddresses;
  // this only fires for a config that leaves the hook unlisted.
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

export function handleAscntConfiguredLegacy(event: AscntConfiguredLegacyEvent): void {
  handleAscntConfiguredLegacyHelper(event)
}

export function handleAscntConfiguredLegacyHelper(event: AscntConfiguredLegacyEvent): void {
  const poolId = event.params.poolId.toHexString()
  const pool = Pool.load(poolId)

  if (!pool) {
    log.warning('Pool not found: {}', [poolId])
    return
  }

  pool.configured = event.params.configured
  pool.minFee = BigInt.fromI32(event.params.minFee)
  pool.maxFee = BigInt.fromI32(event.params.maxFee)
  pool.fallbackFee = BigInt.fromI32(event.params.fallbackFee)
  pool.timeDecayLength = event.params.timeDecayLength
  pool.illiqScale = event.params.illiqScale

  pool.save()
}

export function handleAscntBeforeSwapLegacy(event: AscntBeforeSwapLegacyEvent): void {
  handleAscntBeforeSwapLegacyHelper(event)
}

export function handleAscntBeforeSwapLegacyHelper(event: AscntBeforeSwapLegacyEvent): void {
  const poolId = event.params.poolId.toHexString()
  const pool = Pool.load(poolId)

  if (!pool) {
    log.warning('Pool not found: {}', [poolId])
    return
  }

  pool.sqrtPriceX96Before = event.params.sqrtPriceX96before
  pool.illiqBefore = event.params.illiqBefore
  pool.estimatedVolume1 = event.params.estimatedVolume1
  pool.estimatedPriceImpact = event.params.estimatedPriceImpact
  pool.decayedCumPriceImpact = event.params.decayedCumPriceImpact
  pool.dynamicFeePips = BigInt.fromI32(event.params.dynamicFeePips)

  // create Swap Staging event
  const transaction = loadTransaction(event)
  const swapStaging = new SwapStaging(transaction.id + '-' + pool.id.toString())
  swapStaging.transaction = transaction.id
  swapStaging.pool = pool.id
  swapStaging.sqrtPriceX96Before = event.params.sqrtPriceX96before
  swapStaging.illiqBefore = event.params.illiqBefore
  swapStaging.estimatedVolume1 = event.params.estimatedVolume1
  swapStaging.estimatedPriceImpact = event.params.estimatedPriceImpact
  swapStaging.decayedCumPriceImpact = event.params.decayedCumPriceImpact
  swapStaging.dynamicFeePips = BigInt.fromI32(event.params.dynamicFeePips)

  pool.save()
  swapStaging.save()
}

export function handleAscntAfterSwapLegacy(event: AscntAfterSwapLegacyEvent): void {
  handleAscntAfterSwapLegacyHelper(event)
}

export function handleAscntAfterSwapLegacyHelper(event: AscntAfterSwapLegacyEvent): void {
  const poolId = event.params.poolId.toHexString()
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

  const realPriceImpact = event.params.priceImpact
  const priceImpactError = priceImpactRelativeErrorWad(swap.estimatedPriceImpact, realPriceImpact)

  swap.priceImpact = realPriceImpact
  swap.cumPriceImpact = event.params.cumPriceImpact
  swap.illiq = event.params.illiq
  swap.priceImpactError = priceImpactError

  pool.priceImpact = realPriceImpact
  pool.cumPriceImpact = event.params.cumPriceImpact
  pool.illiq = event.params.illiq
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
