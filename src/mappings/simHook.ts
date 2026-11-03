import { Address, BigInt, ethereum, log } from '@graphprotocol/graph-ts'

import { Bundle, Pool, ProtocolFeeCollection, Token } from '../types/schema'
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
import { ZERO_BD } from '../utils/constants'
import { loadOrCreateHook } from '../utils/hookEntity'
import { convertTokenToDecimal, loadTransaction } from '../utils/index'
import { addAscntProtocolFeesUSD } from '../utils/intervalUpdates'
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

  // Ascnt's cut, charged on the unspecified currency, so one side is zero. Value
  // it now: the take follows the Swap event of the same transaction, so token
  // prices already reflect that swap.
  const token0 = Token.load(pool.token0)
  const token1 = Token.load(pool.token1)
  const bundle = Bundle.load('1')
  let amount0Decimal = ZERO_BD
  let amount1Decimal = ZERO_BD
  let amountUSD = ZERO_BD
  if (token0 !== null && token1 !== null && bundle !== null) {
    amount0Decimal = convertTokenToDecimal(amount0, token0.decimals)
    amount1Decimal = convertTokenToDecimal(amount1, token1.decimals)
    const amountETH = amount0Decimal.times(token0.derivedETH).plus(amount1Decimal.times(token1.derivedETH))
    amountUSD = amountETH.times(bundle.ethPriceUSD)
  } else {
    log.warning('Ascnt protocol fee on pool {} not valued: token or bundle missing', [poolId])
  }
  pool.ascntProtocolFeesToken0 = pool.ascntProtocolFeesToken0.plus(amount0Decimal)
  pool.ascntProtocolFeesToken1 = pool.ascntProtocolFeesToken1.plus(amount1Decimal)
  pool.ascntProtocolFeesUSD = pool.ascntProtocolFeesUSD.plus(amountUSD)
  pool.save()
  addAscntProtocolFeesUSD(pool.id, event.block.timestamp.toI32(), amountUSD)

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
