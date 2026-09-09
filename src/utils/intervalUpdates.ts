import { BigDecimal, BigInt, ethereum, log } from '@graphprotocol/graph-ts'

import { Bundle, Pool, PoolDayData, PoolHourData, Token, TokenDayData, TokenHourData } from './../types/schema'
import { ONE_BI, ZERO_BD, ZERO_BI } from './constants'

// The pool/token updaters take the caller's in-memory entity (with the current
// event's state already applied) rather than re-loading it from the store. The
// store only reflects saved state, and handlers save at the end of processing —
// a store load here would observe the *previous* event's price and lag every
// candle by one swap.
//
// OHLC is written by SWAPS ONLY. A non-null `enteringPrice` (the price the pool
// sat at before this swap executed) marks the event as a swap; null means a
// liquidity change or pool init, which updates the period's state snapshot
// (liquidity/tvl/price trackers) but never the candle — so a candle's existence
// implies real trading. The period's first swap seeds `open` at the entering
// price, i.e. the prior close the pool held until that swap, keeping candles
// gapless across periods (AMM-native, unlike upstream's post-first-swap open).

// 2^32 — logIndex occupies the low 32 bits of the composite ordinal.
const LOG_INDEX_RADIX = BigInt.fromString('4294967296')

// Composite, chain-monotonic ordinal for an event: blockNumber * 2^32 + logIndex.
// Strictly increasing across the whole chain, so it orders events both across
// blocks (a period spans many) and within a block. Used to make the period's
// close independent of trigger execution order.
function eventOrdinal(event: ethereum.Event): BigInt {
  return event.block.number.times(LOG_INDEX_RADIX).plus(event.logIndex)
}

// True when `ordinal` is at least the ordinal that last wrote the close, i.e.
// this swap is the newest so far in the period and may advance it. A null
// stored ordinal means no swap has written the close yet (fresh entity or a
// pre-migration grafted entity) — allow the write.
function closeCanAdvance(storedOrdinal: BigInt | null, ordinal: BigInt): boolean {
  if (storedOrdinal === null) {
    return true
  }
  return ordinal.ge(storedOrdinal)
}

export function updatePoolDayData(
  pool: Pool,
  event: ethereum.Event,
  enteringToken0Price: BigDecimal | null,
): PoolDayData {
  const timestamp = event.block.timestamp.toI32()
  const dayID = timestamp / 86400
  const dayStartTimestamp = dayID * 86400
  const dayPoolID = pool.id.concat('-').concat(dayID.toString())
  let poolDayData = PoolDayData.load(dayPoolID)
  if (poolDayData === null) {
    poolDayData = new PoolDayData(dayPoolID)
    poolDayData.date = dayStartTimestamp
    poolDayData.pool = pool.id
    poolDayData.volumeToken0 = ZERO_BD
    poolDayData.volumeToken1 = ZERO_BD
    poolDayData.volumeUSD = ZERO_BD
    poolDayData.feesUSD = ZERO_BD
    poolDayData.txCount = ZERO_BI
    poolDayData.swapCount = ZERO_BI
    poolDayData.sumDynamicFeePips = ZERO_BI
    poolDayData.maxDynamicFeePips = ZERO_BI
    // OHLC stays null until the period's first swap — a liquidity event or pool
    // init creates the entity for its state snapshot but must not fake a candle.
  }

  // Candle updates: swaps only. The period's first swap seeds open/high/low at
  // the entering price (the prior close), then folds its own post-price in below.
  if (enteringToken0Price !== null) {
    if (poolDayData.open === null) {
      poolDayData.open = enteringToken0Price
      poolDayData.high = enteringToken0Price
      poolDayData.low = enteringToken0Price
    }
    // high/low are order-independent (min/max over the whole period), so they
    // are always considered — this keeps a depeg wick even when it is not the close.
    if (pool.token0Price.gt(poolDayData.high!)) {
      poolDayData.high = pool.token0Price
    }
    if (pool.token0Price.lt(poolDayData.low!)) {
      poolDayData.low = pool.token0Price
    }
    // close: only the highest-ordinal swap of the period may set it, so an
    // out-of-order (earlier) swap can never clobber the true close.
    const ordinal = eventOrdinal(event)
    if (closeCanAdvance(poolDayData.closeOrdinal, ordinal)) {
      poolDayData.close = pool.token0Price
      poolDayData.closeOrdinal = ordinal
    }
  }

  // End-of-period state snapshot: written by every event. Liquidity changes
  // move liquidity/tvl and must land here; they cannot move price, so the
  // price trackers just restate the standing values.
  poolDayData.liquidity = pool.liquidity
  poolDayData.sqrtPrice = pool.sqrtPrice
  poolDayData.token0Price = pool.token0Price
  poolDayData.token1Price = pool.token1Price
  poolDayData.tick = pool.tick
  poolDayData.tvlUSD = pool.totalValueLockedUSD
  poolDayData.txCount = poolDayData.txCount.plus(ONE_BI)
  poolDayData.save()

  return poolDayData as PoolDayData
}

export function updatePoolHourData(
  pool: Pool,
  event: ethereum.Event,
  enteringToken0Price: BigDecimal | null,
): PoolHourData {
  const timestamp = event.block.timestamp.toI32()
  const hourIndex = timestamp / 3600 // get unique hour within unix history
  const hourStartUnix = hourIndex * 3600 // want the rounded effect
  const hourPoolID = pool.id.concat('-').concat(hourIndex.toString())
  let poolHourData = PoolHourData.load(hourPoolID)
  if (poolHourData === null) {
    poolHourData = new PoolHourData(hourPoolID)
    poolHourData.periodStartUnix = hourStartUnix
    poolHourData.pool = pool.id
    poolHourData.volumeToken0 = ZERO_BD
    poolHourData.volumeToken1 = ZERO_BD
    poolHourData.volumeUSD = ZERO_BD
    poolHourData.feesUSD = ZERO_BD
    poolHourData.txCount = ZERO_BI
    poolHourData.swapCount = ZERO_BI
    poolHourData.sumDynamicFeePips = ZERO_BI
    poolHourData.maxDynamicFeePips = ZERO_BI
    // OHLC stays null until the period's first swap — a liquidity event or pool
    // init creates the entity for its state snapshot but must not fake a candle.
  }

  // Candle updates: swaps only. The period's first swap seeds open/high/low at
  // the entering price (the prior close), then folds its own post-price in below.
  if (enteringToken0Price !== null) {
    if (poolHourData.open === null) {
      poolHourData.open = enteringToken0Price
      poolHourData.high = enteringToken0Price
      poolHourData.low = enteringToken0Price
    }
    // high/low are order-independent (min/max over the whole period), so they
    // are always considered — this keeps a depeg wick even when it is not the close.
    if (pool.token0Price.gt(poolHourData.high!)) {
      poolHourData.high = pool.token0Price
    }
    if (pool.token0Price.lt(poolHourData.low!)) {
      poolHourData.low = pool.token0Price
    }
    // close: only the highest-ordinal swap of the period may set it, so an
    // out-of-order (earlier) swap can never clobber the true close.
    const ordinal = eventOrdinal(event)
    if (closeCanAdvance(poolHourData.closeOrdinal, ordinal)) {
      poolHourData.close = pool.token0Price
      poolHourData.closeOrdinal = ordinal
    }
  }

  // End-of-period state snapshot: written by every event. Liquidity changes
  // move liquidity/tvl and must land here; they cannot move price, so the
  // price trackers just restate the standing values.
  poolHourData.liquidity = pool.liquidity
  poolHourData.sqrtPrice = pool.sqrtPrice
  poolHourData.token0Price = pool.token0Price
  poolHourData.token1Price = pool.token1Price
  poolHourData.tick = pool.tick
  poolHourData.tvlUSD = pool.totalValueLockedUSD
  poolHourData.txCount = poolHourData.txCount.plus(ONE_BI)
  poolHourData.save()

  return poolHourData as PoolHourData
}

export function updateTokenDayData(
  token: Token,
  event: ethereum.Event,
  enteringPriceUSD: BigDecimal | null,
): TokenDayData {
  const bundle = Bundle.load('1')!
  const timestamp = event.block.timestamp.toI32()
  const dayID = timestamp / 86400
  const dayStartTimestamp = dayID * 86400
  const tokenDayID = token.id
    .toString()
    .concat('-')
    .concat(dayID.toString())
  const tokenPrice = token.derivedETH.times(bundle.ethPriceUSD)

  let tokenDayData = TokenDayData.load(tokenDayID)
  if (tokenDayData === null) {
    tokenDayData = new TokenDayData(tokenDayID)
    tokenDayData.date = dayStartTimestamp
    tokenDayData.token = token.id
    tokenDayData.volume = ZERO_BD
    tokenDayData.volumeUSD = ZERO_BD
    tokenDayData.feesUSD = ZERO_BD
    tokenDayData.untrackedVolumeUSD = ZERO_BD
    // OHLC stays null until the period's first swap; see updatePoolDayData.
  }

  // Candle updates: swaps only; see updatePoolDayData.
  if (enteringPriceUSD !== null) {
    if (tokenDayData.open === null) {
      tokenDayData.open = enteringPriceUSD
      tokenDayData.high = enteringPriceUSD
      tokenDayData.low = enteringPriceUSD
    }
    if (tokenPrice.gt(tokenDayData.high!)) {
      tokenDayData.high = tokenPrice
    }
    if (tokenPrice.lt(tokenDayData.low!)) {
      tokenDayData.low = tokenPrice
    }
    const ordinal = eventOrdinal(event)
    if (closeCanAdvance(tokenDayData.closeOrdinal, ordinal)) {
      tokenDayData.close = tokenPrice
      tokenDayData.closeOrdinal = ordinal
    }
  }

  // End-of-period state snapshot: written by every event; see updatePoolDayData.
  tokenDayData.priceUSD = tokenPrice
  tokenDayData.totalValueLocked = token.totalValueLocked
  tokenDayData.totalValueLockedUSD = token.totalValueLockedUSD
  tokenDayData.save()

  return tokenDayData as TokenDayData
}

export function updateTokenHourData(
  token: Token,
  event: ethereum.Event,
  enteringPriceUSD: BigDecimal | null,
): TokenHourData {
  const bundle = Bundle.load('1')!
  const timestamp = event.block.timestamp.toI32()
  const hourIndex = timestamp / 3600 // get unique hour within unix history
  const hourStartUnix = hourIndex * 3600 // want the rounded effect
  const tokenHourID = token.id
    .toString()
    .concat('-')
    .concat(hourIndex.toString())
  let tokenHourData = TokenHourData.load(tokenHourID)
  const tokenPrice = token.derivedETH.times(bundle.ethPriceUSD)

  if (tokenHourData === null) {
    tokenHourData = new TokenHourData(tokenHourID)
    tokenHourData.periodStartUnix = hourStartUnix
    tokenHourData.token = token.id
    tokenHourData.volume = ZERO_BD
    tokenHourData.volumeUSD = ZERO_BD
    tokenHourData.untrackedVolumeUSD = ZERO_BD
    tokenHourData.feesUSD = ZERO_BD
    // OHLC stays null until the period's first swap; see updatePoolDayData.
  }

  // Candle updates: swaps only; see updatePoolDayData.
  if (enteringPriceUSD !== null) {
    if (tokenHourData.open === null) {
      tokenHourData.open = enteringPriceUSD
      tokenHourData.high = enteringPriceUSD
      tokenHourData.low = enteringPriceUSD
    }
    if (tokenPrice.gt(tokenHourData.high!)) {
      tokenHourData.high = tokenPrice
    }
    if (tokenPrice.lt(tokenHourData.low!)) {
      tokenHourData.low = tokenPrice
    }
    const ordinal = eventOrdinal(event)
    if (closeCanAdvance(tokenHourData.closeOrdinal, ordinal)) {
      tokenHourData.close = tokenPrice
      tokenHourData.closeOrdinal = ordinal
    }
  }

  // End-of-period state snapshot: written by every event; see updatePoolDayData.
  tokenHourData.priceUSD = tokenPrice
  tokenHourData.totalValueLocked = token.totalValueLocked
  tokenHourData.totalValueLockedUSD = token.totalValueLockedUSD
  tokenHourData.save()

  return tokenHourData as TokenHourData
}

export function updateDynamicFeeAggregates(poolId: string, timestamp: i32, fee: BigInt, swapId: string): void {
  const dayID = timestamp / 86400
  const hourIndex = timestamp / 3600
  const dayPoolID = poolId.concat('-').concat(dayID.toString())
  const hourPoolID = poolId.concat('-').concat(hourIndex.toString())

  const poolDayData = PoolDayData.load(dayPoolID)
  if (poolDayData !== null) {
    poolDayData.sumDynamicFeePips = poolDayData.sumDynamicFeePips.plus(fee)
    if (poolDayData.maxDynamicFeeSwap === null || fee.gt(poolDayData.maxDynamicFeePips)) {
      poolDayData.maxDynamicFeePips = fee
      poolDayData.maxDynamicFeeSwap = swapId
    }
    poolDayData.save()
  } else {
    log.warning('PoolDayData not found for dynamic-fee aggregate: {}', [dayPoolID])
  }

  const poolHourData = PoolHourData.load(hourPoolID)
  if (poolHourData !== null) {
    poolHourData.sumDynamicFeePips = poolHourData.sumDynamicFeePips.plus(fee)
    if (poolHourData.maxDynamicFeeSwap === null || fee.gt(poolHourData.maxDynamicFeePips)) {
      poolHourData.maxDynamicFeePips = fee
      poolHourData.maxDynamicFeeSwap = swapId
    }
    poolHourData.save()
  } else {
    log.warning('PoolHourData not found for dynamic-fee aggregate: {}', [hourPoolID])
  }
}
