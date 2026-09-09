import { Address, BigInt, ethereum, log } from '@graphprotocol/graph-ts'

import { Pool, ProtocolFeeCollection } from '../types/schema'
import {
  AfterSwap as SimHookAfterSwapEvent,
  BeforeSwap as SimHookBeforeSwapEvent,
  PoolConfigured as SimHookConfiguredEvent,
  PoolInitialized as SimHookInitializedEvent,
  ProtocolFeeBpsCached as ProtocolFeeBpsCachedEvent,
  ProtocolFeeTaken as ProtocolFeeTakenEvent,
  ProtocolFeeTakenAsClaims as ProtocolFeeTakenAsClaimsEvent,
} from '../types/templates/SimHook/SimHook'
import { getSubgraphConfig } from '../utils/chains'
import { ZERO_BI } from '../utils/constants'
import { loadOrCreateHook } from '../utils/hookEntity'
import { loadTransaction } from '../utils/index'
import { ascntAfterSwapCore, ascntBeforeSwapCore, ascntInitializedCore } from './ascntCore'

// Handlers for the gov-version SimHook, instantiated per hook by
// handleHookDeployed. Swap/init events share cores with the MVP handlers; the
// configured and protocol-fee events are new shapes.

export function handleSimHookAfterSwap(event: SimHookAfterSwapEvent): void {
  ascntAfterSwapCore(event, event.params.poolId.toHexString(), event.params.priceImpact, event.params.cumPriceImpact)
}

export function handleSimHookBeforeSwap(event: SimHookBeforeSwapEvent): void {
  ascntBeforeSwapCore(
    event,
    event.params.poolId.toHexString(),
    event.params.sqrtPriceX96Before,
    event.params.priceImpact,
    event.params.decayedCumPriceImpact,
    BigInt.fromI32(event.params.dynamicFeePips),
  )
}

export function handleSimHookInitialized(event: SimHookInitializedEvent): void {
  ascntInitializedCore(event.params.id.toHexString(), getSubgraphConfig())
}

export function handleSimHookConfigured(event: SimHookConfiguredEvent): void {
  const poolId = event.params.poolId.toHexString()
  const pool = Pool.load(poolId)

  if (!pool) {
    log.warning('Pool not found: {}', [poolId])
    return
  }

  pool.configured = event.params.configured
  // the min fee is a range; surface the lower bound as the pool's minFee
  pool.minFee = BigInt.fromI32(event.params.minMinFee)
  pool.maxMinFee = BigInt.fromI32(event.params.maxMinFee)
  pool.maxFee = BigInt.fromI32(event.params.maxFee)
  pool.timeDecayLength = event.params.timeDecayLength
  pool.jitLockBlocks = event.params.jitLockBlocks
  pool.kPips = event.params.kPips
  pool.cPips = event.params.cPips

  pool.save()
}

function protocolFeeTakenCore(
  event: ethereum.Event,
  poolId: string,
  treasury: Address,
  amount0: BigInt,
  amount1: BigInt,
  asClaims: boolean,
): void {
  const hook = loadOrCreateHook(event.address, event)
  const pool = Pool.load(poolId)

  if (!pool) {
    log.warning('Pool not found: {}', [poolId])
    return
  }

  // nullable on pools that predate the v1.0.0 schema (grafted history)
  const prev0 = pool.protocolFeesToken0
  const prev1 = pool.protocolFeesToken1
  pool.protocolFeesToken0 = (prev0 === null ? ZERO_BI : (prev0 as BigInt)).plus(amount0)
  pool.protocolFeesToken1 = (prev1 === null ? ZERO_BI : (prev1 as BigInt)).plus(amount1)
  pool.save()

  const transaction = loadTransaction(event)
  const collection = new ProtocolFeeCollection(transaction.id + '-' + event.logIndex.toString())
  collection.hook = hook.id
  collection.pool = pool.id
  collection.treasury = treasury
  collection.amount0 = amount0
  collection.amount1 = amount1
  collection.asClaims = asClaims
  collection.transaction = transaction.id
  collection.timestamp = transaction.timestamp
  collection.logIndex = event.logIndex
  collection.save()
}

export function handleProtocolFeeTaken(event: ProtocolFeeTakenEvent): void {
  protocolFeeTakenCore(
    event,
    event.params.poolId.toHexString(),
    event.params.treasury,
    event.params.amount0,
    event.params.amount1,
    false,
  )
}

export function handleProtocolFeeTakenAsClaims(event: ProtocolFeeTakenAsClaimsEvent): void {
  protocolFeeTakenCore(
    event,
    event.params.poolId.toHexString(),
    event.params.treasury,
    event.params.amount0,
    event.params.amount1,
    true,
  )
}

export function handleProtocolFeeBpsCached(event: ProtocolFeeBpsCachedEvent): void {
  const hook = loadOrCreateHook(event.address, event)
  hook.cachedProtocolFeeBps = BigInt.fromI32(event.params.bps)
  hook.save()
}
