import { BigDecimal, BigInt, ethereum } from '@graphprotocol/graph-ts'
import { afterEach, assert, beforeEach, clearStore, describe, newMockEvent, test } from 'matchstick-as'

import { Bundle, Pool, PoolDayData, PoolHourData, Token, TokenHourData } from '../../src/types/schema'
import {
  updatePoolDayData,
  updatePoolHourData,
  updateTokenDayData,
  updateTokenHourData,
} from '../../src/utils/intervalUpdates'
import {
  createAndStoreTestPool,
  createAndStoreTestToken,
  USDC_MAINNET_FIXTURE,
  USDC_WETH_05_MAINNET_POOL_FIXTURE,
  USDC_WETH_POOL_ID,
} from '../handlers/constants'

// Fixed timestamp so all events fall in the same hour/day bucket (i.e. the same
// PoolHourData / PoolDayData entity).
const TS = 1600000000
const HOUR_ID = TS / 3600
const DAY_ID = TS / 86400
const RADIX = BigInt.fromString('4294967296') // 2^32

const HOUR_ENTITY = USDC_WETH_POOL_ID + '-' + HOUR_ID.toString()
const DAY_ENTITY = USDC_WETH_POOL_ID + '-' + DAY_ID.toString()

const PEG = BigDecimal.fromString('1') // victim swap leaves the pool on peg
const DEPEG = BigDecimal.fromString('0.5') // MEV swap pushes token0 off peg

// Build an event at a specific (blockNumber, logIndex) but a fixed bucket timestamp.
function eventAt(blockNumber: i32, logIndex: i32): ethereum.Event {
  const e = newMockEvent()
  e.block.number = BigInt.fromI32(blockNumber)
  e.block.timestamp = BigInt.fromI32(TS)
  e.logIndex = BigInt.fromI32(logIndex)
  return e
}

function ordinal(blockNumber: i32, logIndex: i32): string {
  return BigInt.fromI32(blockNumber)
    .times(RADIX)
    .plus(BigInt.fromI32(logIndex))
    .toString()
}

function setPoolPrice(price: string): void {
  const pool = Pool.load(USDC_WETH_POOL_ID)!
  pool.token0Price = BigDecimal.fromString(price)
  pool.save()
}

// Mirror the swap handler's flow: capture the entering (pre-swap) price, apply
// the swap's post-price to the in-memory pool, then run the interval updates
// with that same object — the pool is only saved afterwards, as in swap.ts.
function swapTo(newPrice: string, event: ethereum.Event): void {
  const pool = Pool.load(USDC_WETH_POOL_ID)!
  const enteringPrice = pool.token0Price
  pool.token0Price = BigDecimal.fromString(newPrice)
  updatePoolDayData(pool, event, enteringPrice)
  updatePoolHourData(pool, event, enteringPrice)
  pool.save()
}

// Mirror a liquidity event (modifyLiquidity/init): price cannot move, and a
// null entering price tells the updaters to snapshot state without a candle.
function liquidityEvent(event: ethereum.Event): void {
  const pool = Pool.load(USDC_WETH_POOL_ID)!
  updatePoolDayData(pool, event, null)
  updatePoolHourData(pool, event, null)
  pool.save()
}

function assertHourOHLC(open: string, high: string, low: string, close: string): void {
  assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'open', open)
  assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'high', high)
  assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'low', low)
  assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'close', close)
}

function assertDayOHLC(open: string, high: string, low: string, close: string): void {
  assert.fieldEquals('PoolDayData', DAY_ENTITY, 'open', open)
  assert.fieldEquals('PoolDayData', DAY_ENTITY, 'high', high)
  assert.fieldEquals('PoolDayData', DAY_ENTITY, 'low', low)
  assert.fieldEquals('PoolDayData', DAY_ENTITY, 'close', close)
}

describe('interval OHLC (one-swap lag + AMM-native open)', () => {
  beforeEach(() => {
    createAndStoreTestPool(USDC_WETH_05_MAINNET_POOL_FIXTURE)
  })

  afterEach(() => {
    clearStore()
  })

  test('candle reflects the current swap, not the previously saved price (no one-swap lag)', () => {
    setPoolPrice('1')
    // The interval update runs on the UNSAVED in-memory pool carrying this
    // swap's post-price. Before the fix the updater re-loaded the pool from the
    // store and recorded the previous swap's price ('1') as the close.
    const pool = Pool.load(USDC_WETH_POOL_ID)!
    const enteringPrice = pool.token0Price
    pool.token0Price = BigDecimal.fromString('2')
    updatePoolDayData(pool, eventAt(100, 1), enteringPrice)
    updatePoolHourData(pool, eventAt(100, 1), enteringPrice)

    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'close', '2')
    assert.fieldEquals('PoolDayData', DAY_ENTITY, 'close', '2')
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'token0Price', '2')
  })

  test('single-swap bucket: open = entering price, body to post-swap price (no gapped doji)', () => {
    setPoolPrice('0.999398')
    swapTo('0.999431', eventAt(100, 1))

    assertHourOHLC('0.999398', '0.999431', '0.999398', '0.999431')
    assertDayOHLC('0.999398', '0.999431', '0.999398', '0.999431')
  })

  // Live mainnet regression (plan): hour bucket 15:00 held swaps to 0.999431 and
  // 0.999493 while the pool entered the hour sitting at 0.999398 (prior close).
  test('multi-swap bucket matches live regression values (up-close)', () => {
    setPoolPrice('0.999398')
    swapTo('0.999431', eventAt(100, 1))
    swapTo('0.999493', eventAt(100, 2))

    assertHourOHLC('0.999398', '0.999493', '0.999398', '0.999493')
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'closeOrdinal', ordinal(100, 2))
  })

  // Live mainnet regression (plan): hour bucket 17:00 — pool entered at
  // 0.9994929, ticked up to 0.9994935, then closed down at 0.999404. Before the
  // fix the final swap's price went missing entirely (it sat below the recorded
  // low and never surfaced as any bucket's close).
  test('multi-swap bucket matches live regression values (down-close)', () => {
    setPoolPrice('0.9994929')
    swapTo('0.9994935', eventAt(200, 1))
    swapTo('0.999404', eventAt(200, 2))

    assertHourOHLC('0.9994929', '0.9994935', '0.999404', '0.999404')
  })

  test('bucket continuity: next bucket opens at the previous bucket true close', () => {
    setPoolPrice('1')
    swapTo('0.999493', eventAt(100, 1))

    // Next hour bucket, first swap: the entering price is the prior close.
    const nextHourTs = (HOUR_ID + 1) * 3600
    const e = newMockEvent()
    e.block.number = BigInt.fromI32(101)
    e.block.timestamp = BigInt.fromI32(nextHourTs)
    e.logIndex = BigInt.fromI32(1)
    swapTo('0.999404', e)

    const nextHourEntity = USDC_WETH_POOL_ID + '-' + (HOUR_ID + 1).toString()
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'close', '0.999493')
    assert.fieldEquals('PoolHourData', nextHourEntity, 'open', '0.999493')
    assert.fieldEquals('PoolHourData', nextHourEntity, 'close', '0.999404')
  })
})

describe('swaps-only candles (liquidity events write state, not OHLC)', () => {
  beforeEach(() => {
    createAndStoreTestPool(USDC_WETH_05_MAINNET_POOL_FIXTURE)
    setPoolPrice('0.999398')
  })

  afterEach(() => {
    clearStore()
  })

  test('a liquidity event creates the bucket with state but no candle', () => {
    const pool = Pool.load(USDC_WETH_POOL_ID)!
    pool.liquidity = BigInt.fromI32(12345)
    updatePoolDayData(pool, eventAt(100, 1), null)
    updatePoolHourData(pool, eventAt(100, 1), null)
    pool.save()

    // The state snapshot is written...
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'liquidity', '12345')
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'token0Price', '0.999398')
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'txCount', '1')
    // ...but no candle exists and no close ordinal was consumed.
    const hourData = PoolHourData.load(HOUR_ENTITY)!
    assert.assertTrue(hourData.open === null)
    assert.assertTrue(hourData.high === null)
    assert.assertTrue(hourData.low === null)
    assert.assertTrue(hourData.close === null)
    assert.assertTrue(hourData.closeOrdinal === null)
    const dayData = PoolDayData.load(DAY_ENTITY)!
    assert.assertTrue(dayData.open === null)
    assert.assertTrue(dayData.close === null)
  })

  test('the first swap after a liquidity-created bucket opens at the prior close', () => {
    liquidityEvent(eventAt(100, 1))
    swapTo('0.999431', eventAt(100, 2))

    assertHourOHLC('0.999398', '0.999431', '0.999398', '0.999431')
    assertDayOHLC('0.999398', '0.999431', '0.999398', '0.999431')
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'closeOrdinal', ordinal(100, 2))
  })

  test('a liquidity event after a swap updates state but leaves the candle untouched', () => {
    swapTo('0.999431', eventAt(100, 1))

    const pool = Pool.load(USDC_WETH_POOL_ID)!
    pool.liquidity = BigInt.fromI32(777)
    pool.totalValueLockedUSD = BigDecimal.fromString('1000')
    updatePoolDayData(pool, eventAt(100, 5), null)
    updatePoolHourData(pool, eventAt(100, 5), null)
    pool.save()

    // Candle still reflects the swap only; closeOrdinal was not advanced.
    assertHourOHLC('0.999398', '0.999431', '0.999398', '0.999431')
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'closeOrdinal', ordinal(100, 1))
    // State snapshot reflects the liquidity event.
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'liquidity', '777')
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'tvlUSD', '1000')
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'txCount', '2')
  })
})

describe('interval close ordering (intra-block depeg)', () => {
  beforeEach(() => {
    createAndStoreTestPool(USDC_WETH_05_MAINNET_POOL_FIXTURE)
    setPoolPrice('1')
  })

  afterEach(() => {
    clearStore()
  })

  test('an out-of-order earlier depeg swap does not overwrite the later victim close', () => {
    // 1) Victim swap has the higher log position (executes last on-chain); peg holds.
    swapTo(PEG.toString(), eventAt(100, 10))
    // 2) The earlier MEV/depeg swap (lower log position) is processed out of order.
    swapTo(DEPEG.toString(), eventAt(100, 5))

    // close must reflect the victim (highest-ordinal) swap, not the depeg.
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'close', PEG.toString())
    assert.fieldEquals('PoolDayData', DAY_ENTITY, 'close', PEG.toString())
    // ...while the depeg is still preserved as the low wick.
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'low', DEPEG.toString())
    assert.fieldEquals('PoolDayData', DAY_ENTITY, 'low', DEPEG.toString())
    // and the guard recorded the victim's ordinal.
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'closeOrdinal', ordinal(100, 10))
    assert.fieldEquals('PoolDayData', DAY_ENTITY, 'closeOrdinal', ordinal(100, 10))
  })

  test('in-order swaps still advance the close normally', () => {
    // Depeg first (lower ordinal), victim second (higher ordinal) — the newest wins.
    swapTo(DEPEG.toString(), eventAt(100, 5))
    swapTo(PEG.toString(), eventAt(100, 10))

    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'close', PEG.toString())
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'low', DEPEG.toString())
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'closeOrdinal', ordinal(100, 10))
  })

  test('a later-block event in the same hour advances the close', () => {
    // Same hour bucket, but a later block — ordinal must order across blocks too.
    swapTo(PEG.toString(), eventAt(100, 900))
    swapTo(DEPEG.toString(), eventAt(101, 1))

    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'close', DEPEG.toString())
    assert.fieldEquals('PoolHourData', HOUR_ENTITY, 'closeOrdinal', ordinal(101, 1))
  })
})

const TOKEN_HOUR_ENTITY = USDC_MAINNET_FIXTURE.address + '-' + HOUR_ID.toString()
const TOKEN_DAY_ENTITY = USDC_MAINNET_FIXTURE.address + '-' + DAY_ID.toString()

// Set the token's current USD price via derivedETH (price = derivedETH * 2000),
// then run the updaters with an explicit entering price, as swap.ts does.
function tokenSwapTo(enteringPriceUSD: string, newPriceUSD: string, event: ethereum.Event): void {
  const token = Token.load(USDC_MAINNET_FIXTURE.address)!
  token.derivedETH = BigDecimal.fromString(newPriceUSD).div(BigDecimal.fromString('2000'))
  token.save()
  updateTokenDayData(token, event, BigDecimal.fromString(enteringPriceUSD))
  updateTokenHourData(token, event, BigDecimal.fromString(enteringPriceUSD))
}

describe('token interval OHLC (AMM-native open)', () => {
  beforeEach(() => {
    const bundle = new Bundle('1')
    bundle.ethPriceUSD = BigDecimal.fromString('2000')
    bundle.save()
    createAndStoreTestToken(USDC_MAINNET_FIXTURE)
  })

  afterEach(() => {
    clearStore()
  })

  test('new token bucket opens at the entering price and closes at the current one', () => {
    tokenSwapTo('0.9', '1', eventAt(100, 1))

    assert.fieldEquals('TokenHourData', TOKEN_HOUR_ENTITY, 'open', '0.9')
    assert.fieldEquals('TokenHourData', TOKEN_HOUR_ENTITY, 'low', '0.9')
    assert.fieldEquals('TokenHourData', TOKEN_HOUR_ENTITY, 'high', '1')
    assert.fieldEquals('TokenHourData', TOKEN_HOUR_ENTITY, 'close', '1')
    assert.fieldEquals('TokenDayData', TOKEN_DAY_ENTITY, 'open', '0.9')
    assert.fieldEquals('TokenDayData', TOKEN_DAY_ENTITY, 'close', '1')
  })

  test('subsequent updates leave open untouched and advance the close', () => {
    tokenSwapTo('0.9', '1', eventAt(100, 1))
    tokenSwapTo('1', '0.8', eventAt(100, 2))

    assert.fieldEquals('TokenHourData', TOKEN_HOUR_ENTITY, 'open', '0.9')
    assert.fieldEquals('TokenHourData', TOKEN_HOUR_ENTITY, 'low', '0.8')
    assert.fieldEquals('TokenHourData', TOKEN_HOUR_ENTITY, 'high', '1')
    assert.fieldEquals('TokenHourData', TOKEN_HOUR_ENTITY, 'close', '0.8')
    assert.fieldEquals('TokenHourData', TOKEN_HOUR_ENTITY, 'closeOrdinal', ordinal(100, 2))
  })

  test('a liquidity event leaves the token bucket without a candle but with state', () => {
    const token = Token.load(USDC_MAINNET_FIXTURE.address)!
    token.derivedETH = BigDecimal.fromString('1').div(BigDecimal.fromString('2000'))
    token.save()
    updateTokenDayData(token, eventAt(100, 1), null)
    updateTokenHourData(token, eventAt(100, 1), null)

    // State snapshot recorded (priceUSD = derivedETH * ethPriceUSD = 1)...
    assert.fieldEquals('TokenHourData', TOKEN_HOUR_ENTITY, 'priceUSD', '1')
    // ...but no candle.
    const hourData = TokenHourData.load(TOKEN_HOUR_ENTITY)!
    assert.assertTrue(hourData.open === null)
    assert.assertTrue(hourData.high === null)
    assert.assertTrue(hourData.low === null)
    assert.assertTrue(hourData.close === null)
    assert.assertTrue(hourData.closeOrdinal === null)
  })
})
