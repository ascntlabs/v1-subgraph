import { Address, BigInt, Bytes, ethereum } from '@graphprotocol/graph-ts'
import { assert, beforeEach, clearStore, describe, test } from 'matchstick-as'

import { handleAscntAfterSwapHelper } from '../../src/mappings/ascntAfterSwap'
import { handleAscntBeforeSwapHelper } from '../../src/mappings/ascntBeforeSwap'
import { handleSwapHelper } from '../../src/mappings/swap'
import { Swap as SwapEvent } from '../../src/types/PoolManager/PoolManager'
import { Bundle, Token } from '../../src/types/schema'
import { AfterSwap, BeforeSwap } from '../../src/types/SimHookMVPLegacy/SimHookMVPLegacy'
import {
  createAndStoreTestPool,
  createAndStoreTestToken,
  invokePoolCreatedWithMockedEthCalls,
  MOCK_EVENT,
  TEST_CONFIG,
  TEST_ETH_PRICE_USD,
  TEST_USDC_DERIVED_ETH,
  TEST_WETH_DERIVED_ETH,
  USDC_MAINNET_FIXTURE,
  USDC_WETH_POOL_ID,
  WBTC_MAINNET_FIXTURE,
  WBTC_WETH_03_MAINNET_POOL_FIXTURE,
  WBTC_WETH_POOL_ID,
  WETH_MAINNET_FIXTURE,
} from './constants'

// Pool A fixtures (USDC/WETH) — used by both the single-pool test and as the first pool
// in the multi-pool test.
class BeforeFixture {
  sqrtPriceX96Before: string
  sqrtPriceX96AfterSim: string
  priceImpact: string
  decayedCumPriceImpact: string
  effectiveMinFee: i32
  dynamicFeePips: i32
  timestamp: string
}

class SwapFixture {
  sender: Address
  amount0: BigInt
  amount1: BigInt
  sqrtPriceX96: BigInt
  liquidity: BigInt
  tick: i32
  fee: i32
}

class AfterFixture {
  sqrtPriceX96after: string
  priceImpact: string
  cumPriceImpact: string
  timestamp: string
}

const BEFORE_A: BeforeFixture = {
  sqrtPriceX96Before: '79228162514264337593543950336',
  sqrtPriceX96AfterSim: '79228162514264337514315787821',
  priceImpact: '500000000000000',
  decayedCumPriceImpact: '250000000000000',
  effectiveMinFee: 400,
  dynamicFeePips: 3000,
  timestamp: '1700000000',
}

const SWAP_A: SwapFixture = {
  sender: Address.fromString('0x841B5A0b3DBc473c8A057E2391014aa4C4751351'),
  amount0: BigInt.fromString('-10007'),
  amount1: BigInt.fromString('10000'),
  sqrtPriceX96: BigInt.fromString('79228162514264337514315787821'),
  liquidity: BigInt.fromString('10000000000000000000000'),
  tick: -1,
  fee: 500,
}

const AFTER_A: AfterFixture = {
  sqrtPriceX96after: '79228162514264337514315787821',
  priceImpact: '480000000000000',
  cumPriceImpact: '730000000000000',
  timestamp: '1700000000',
}

// |500000000000000 - 480000000000000| * 1e18 / 480000000000000, truncated
const PRICE_IMPACT_ERROR_A = '41666666666666666'

// Pool B fixtures (WBTC/WETH) — distinct values so cross-contamination would be visible.
const BEFORE_B: BeforeFixture = {
  sqrtPriceX96Before: '79228162514264337593543950336',
  sqrtPriceX96AfterSim: '79228162514264337514315787821',
  priceImpact: '700000000000000',
  decayedCumPriceImpact: '350000000000000',
  effectiveMinFee: 600,
  dynamicFeePips: 5000,
  timestamp: '1700000000',
}

const SWAP_B: SwapFixture = {
  sender: Address.fromString('0x841B5A0b3DBc473c8A057E2391014aa4C4751351'),
  amount0: BigInt.fromString('-1'),
  amount1: BigInt.fromString('20'),
  sqrtPriceX96: BigInt.fromString('79228162514264337514315787821'),
  liquidity: BigInt.fromString('10000000000000000000000'),
  tick: -1,
  fee: 3000,
}

const AFTER_B: AfterFixture = {
  sqrtPriceX96after: '79228162514264337514315787821',
  priceImpact: '680000000000000',
  cumPriceImpact: '1030000000000000',
  timestamp: '1700000000',
}

function makeBeforeSwapEvent(poolId: string, fixture: BeforeFixture, logIndex: i32): BeforeSwap {
  const poolIdBytes = Bytes.fromHexString(poolId) as Bytes
  return new BeforeSwap(
    MOCK_EVENT.address,
    BigInt.fromI32(logIndex),
    MOCK_EVENT.transactionLogIndex,
    MOCK_EVENT.logType,
    MOCK_EVENT.block,
    MOCK_EVENT.transaction,
    [
      new ethereum.EventParam('poolId', ethereum.Value.fromFixedBytes(poolIdBytes)),
      new ethereum.EventParam(
        'sqrtPriceX96Before',
        ethereum.Value.fromUnsignedBigInt(BigInt.fromString(fixture.sqrtPriceX96Before)),
      ),
      new ethereum.EventParam(
        'sqrtPriceX96AfterSim',
        ethereum.Value.fromUnsignedBigInt(BigInt.fromString(fixture.sqrtPriceX96AfterSim)),
      ),
      new ethereum.EventParam('priceImpact', ethereum.Value.fromUnsignedBigInt(BigInt.fromString(fixture.priceImpact))),
      new ethereum.EventParam(
        'decayedCumPriceImpact',
        ethereum.Value.fromSignedBigInt(BigInt.fromString(fixture.decayedCumPriceImpact)),
      ),
      new ethereum.EventParam('effectiveMinFee', ethereum.Value.fromI32(fixture.effectiveMinFee)),
      new ethereum.EventParam('dynamicFeePips', ethereum.Value.fromI32(fixture.dynamicFeePips)),
      new ethereum.EventParam('timestamp', ethereum.Value.fromUnsignedBigInt(BigInt.fromString(fixture.timestamp))),
    ],
    MOCK_EVENT.receipt,
  )
}

function makeSwapEvent(poolId: string, fixture: SwapFixture, logIndex: i32): SwapEvent {
  const poolIdBytes = Bytes.fromHexString(poolId) as Bytes
  return new SwapEvent(
    MOCK_EVENT.address,
    BigInt.fromI32(logIndex),
    MOCK_EVENT.transactionLogIndex,
    MOCK_EVENT.logType,
    MOCK_EVENT.block,
    MOCK_EVENT.transaction,
    [
      new ethereum.EventParam('id', ethereum.Value.fromFixedBytes(poolIdBytes)),
      new ethereum.EventParam('sender', ethereum.Value.fromAddress(fixture.sender)),
      new ethereum.EventParam('amount0', ethereum.Value.fromSignedBigInt(fixture.amount0)),
      new ethereum.EventParam('amount1', ethereum.Value.fromSignedBigInt(fixture.amount1)),
      new ethereum.EventParam('sqrtPriceX96', ethereum.Value.fromSignedBigInt(fixture.sqrtPriceX96)),
      new ethereum.EventParam('liquidity', ethereum.Value.fromSignedBigInt(fixture.liquidity)),
      new ethereum.EventParam('tick', ethereum.Value.fromI32(fixture.tick)),
      new ethereum.EventParam('fee', ethereum.Value.fromI32(fixture.fee)),
    ],
    MOCK_EVENT.receipt,
  )
}

function makeAfterSwapEvent(poolId: string, fixture: AfterFixture, logIndex: i32): AfterSwap {
  const poolIdBytes = Bytes.fromHexString(poolId) as Bytes
  return new AfterSwap(
    MOCK_EVENT.address,
    BigInt.fromI32(logIndex),
    MOCK_EVENT.transactionLogIndex,
    MOCK_EVENT.logType,
    MOCK_EVENT.block,
    MOCK_EVENT.transaction,
    [
      new ethereum.EventParam('poolId', ethereum.Value.fromFixedBytes(poolIdBytes)),
      new ethereum.EventParam(
        'sqrtPriceX96',
        ethereum.Value.fromUnsignedBigInt(BigInt.fromString(fixture.sqrtPriceX96after)),
      ),
      new ethereum.EventParam('priceImpact', ethereum.Value.fromUnsignedBigInt(BigInt.fromString(fixture.priceImpact))),
      new ethereum.EventParam(
        'cumPriceImpact',
        ethereum.Value.fromSignedBigInt(BigInt.fromString(fixture.cumPriceImpact)),
      ),
      new ethereum.EventParam('timestamp', ethereum.Value.fromUnsignedBigInt(BigInt.fromString(fixture.timestamp))),
    ],
    MOCK_EVENT.receipt,
  )
}

describe('Ascnt swap-staging pipeline', () => {
  beforeEach(() => {
    clearStore()
    invokePoolCreatedWithMockedEthCalls(MOCK_EVENT, TEST_CONFIG)

    const bundle = new Bundle('1')
    bundle.ethPriceUSD = TEST_ETH_PRICE_USD
    bundle.save()

    const usdc = Token.load(USDC_MAINNET_FIXTURE.address)!
    usdc.derivedETH = TEST_USDC_DERIVED_ETH
    usdc.save()

    const weth = Token.load(WETH_MAINNET_FIXTURE.address)!
    weth.derivedETH = TEST_WETH_DERIVED_ETH
    weth.save()
  })

  test('BeforeSwap → Swap → AfterSwap stitches Swap, populates aggregates, clears staging', () => {
    const txHash = MOCK_EVENT.transaction.hash.toHexString()
    const swapStagingId = txHash + '-' + USDC_WETH_POOL_ID
    const swapEntityId = txHash + '-1'
    const dayId = MOCK_EVENT.block.timestamp.toI32() / 86400
    const hourId = MOCK_EVENT.block.timestamp.toI32() / 3600
    const poolDayDataId = USDC_WETH_POOL_ID + '-' + dayId.toString()
    const poolHourDataId = USDC_WETH_POOL_ID + '-' + hourId.toString()

    handleAscntBeforeSwapHelper(makeBeforeSwapEvent(USDC_WETH_POOL_ID, BEFORE_A, 0))

    assert.fieldEquals('SwapStaging', swapStagingId, 'pool', USDC_WETH_POOL_ID)
    assert.fieldEquals('SwapStaging', swapStagingId, 'sqrtPriceX96Before', BEFORE_A.sqrtPriceX96Before)
    assert.fieldEquals('SwapStaging', swapStagingId, 'estimatedPriceImpact', BEFORE_A.priceImpact)
    assert.fieldEquals('SwapStaging', swapStagingId, 'dynamicFeePips', BEFORE_A.dynamicFeePips.toString())

    handleSwapHelper(makeSwapEvent(USDC_WETH_POOL_ID, SWAP_A, 1), TEST_CONFIG)

    assert.fieldEquals('SwapStaging', swapStagingId, 'swapId', swapEntityId)
    assert.fieldEquals('Swap', swapEntityId, 'sqrtPriceX96Before', BEFORE_A.sqrtPriceX96Before)
    assert.fieldEquals('Swap', swapEntityId, 'dynamicFeePips', BEFORE_A.dynamicFeePips.toString())

    handleAscntAfterSwapHelper(makeAfterSwapEvent(USDC_WETH_POOL_ID, AFTER_A, 2))

    assert.notInStore('SwapStaging', swapStagingId)
    assert.fieldEquals('Swap', swapEntityId, 'priceImpact', AFTER_A.priceImpact)
    assert.fieldEquals('Swap', swapEntityId, 'cumPriceImpact', AFTER_A.cumPriceImpact)
    assert.fieldEquals('Swap', swapEntityId, 'priceImpactError', PRICE_IMPACT_ERROR_A)

    assert.fieldEquals('PoolDayData', poolDayDataId, 'sumDynamicFeePips', BEFORE_A.dynamicFeePips.toString())
    assert.fieldEquals('PoolDayData', poolDayDataId, 'maxDynamicFeePips', BEFORE_A.dynamicFeePips.toString())
    assert.fieldEquals('PoolDayData', poolDayDataId, 'maxDynamicFeeSwap', swapEntityId)
    assert.fieldEquals('PoolHourData', poolHourDataId, 'sumDynamicFeePips', BEFORE_A.dynamicFeePips.toString())
    assert.fieldEquals('PoolHourData', poolHourDataId, 'maxDynamicFeePips', BEFORE_A.dynamicFeePips.toString())
    assert.fieldEquals('PoolHourData', poolHourDataId, 'maxDynamicFeeSwap', swapEntityId)
  })

  test('two pools in one tx: each cycle stitches its own swap, no cross-contamination', () => {
    // beforeEach set up pool A and the WETH/USDC tokens. Add pool B (WBTC/WETH).
    createAndStoreTestPool(WBTC_WETH_03_MAINNET_POOL_FIXTURE)
    createAndStoreTestToken(WBTC_MAINNET_FIXTURE)
    const wbtc = Token.load(WBTC_MAINNET_FIXTURE.address)!
    wbtc.derivedETH = TEST_WETH_DERIVED_ETH // any non-zero derived price is fine here
    wbtc.save()

    const txHash = MOCK_EVENT.transaction.hash.toHexString()
    const stagingAId = txHash + '-' + USDC_WETH_POOL_ID
    const stagingBId = txHash + '-' + WBTC_WETH_POOL_ID
    const swapAId = txHash + '-1'
    const swapBId = txHash + '-4'
    const dayId = MOCK_EVENT.block.timestamp.toI32() / 86400
    const poolADayDataId = USDC_WETH_POOL_ID + '-' + dayId.toString()
    const poolBDayDataId = WBTC_WETH_POOL_ID + '-' + dayId.toString()

    // Realistic v4 ordering: each pool's Before→Swap→After completes before the next pool's begins.
    // Pool A cycle (log indices 0, 1, 2).
    handleAscntBeforeSwapHelper(makeBeforeSwapEvent(USDC_WETH_POOL_ID, BEFORE_A, 0))
    handleSwapHelper(makeSwapEvent(USDC_WETH_POOL_ID, SWAP_A, 1), TEST_CONFIG)
    handleAscntAfterSwapHelper(makeAfterSwapEvent(USDC_WETH_POOL_ID, AFTER_A, 2))

    // Pool A staging cleared, pool B staging not yet created.
    assert.notInStore('SwapStaging', stagingAId)
    assert.notInStore('SwapStaging', stagingBId)

    // Pool B cycle (log indices 3, 4, 5).
    handleAscntBeforeSwapHelper(makeBeforeSwapEvent(WBTC_WETH_POOL_ID, BEFORE_B, 3))

    // Pool A staging stays absent (was cleared); pool B staging now exists with its own key.
    assert.notInStore('SwapStaging', stagingAId)
    assert.fieldEquals('SwapStaging', stagingBId, 'pool', WBTC_WETH_POOL_ID)
    assert.fieldEquals('SwapStaging', stagingBId, 'dynamicFeePips', BEFORE_B.dynamicFeePips.toString())

    handleSwapHelper(makeSwapEvent(WBTC_WETH_POOL_ID, SWAP_B, 4), TEST_CONFIG)
    handleAscntAfterSwapHelper(makeAfterSwapEvent(WBTC_WETH_POOL_ID, AFTER_B, 5))

    // Both stagings are gone.
    assert.notInStore('SwapStaging', stagingAId)
    assert.notInStore('SwapStaging', stagingBId)

    // Each Swap entity carries its own pool's values — no cross-contamination.
    assert.fieldEquals('Swap', swapAId, 'pool', USDC_WETH_POOL_ID)
    assert.fieldEquals('Swap', swapAId, 'dynamicFeePips', BEFORE_A.dynamicFeePips.toString())
    assert.fieldEquals('Swap', swapAId, 'priceImpact', AFTER_A.priceImpact)

    assert.fieldEquals('Swap', swapBId, 'pool', WBTC_WETH_POOL_ID)
    assert.fieldEquals('Swap', swapBId, 'dynamicFeePips', BEFORE_B.dynamicFeePips.toString())
    assert.fieldEquals('Swap', swapBId, 'priceImpact', AFTER_B.priceImpact)

    // Per-pool day aggregates each see their own dynamicFeePips and Swap pointer.
    assert.fieldEquals('PoolDayData', poolADayDataId, 'sumDynamicFeePips', BEFORE_A.dynamicFeePips.toString())
    assert.fieldEquals('PoolDayData', poolADayDataId, 'maxDynamicFeeSwap', swapAId)
    assert.fieldEquals('PoolDayData', poolBDayDataId, 'sumDynamicFeePips', BEFORE_B.dynamicFeePips.toString())
    assert.fieldEquals('PoolDayData', poolBDayDataId, 'maxDynamicFeeSwap', swapBId)
  })
})
