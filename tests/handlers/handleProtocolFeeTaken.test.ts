import { Address, BigDecimal, BigInt, Bytes, ethereum } from '@graphprotocol/graph-ts'
import { assert, beforeEach, clearStore, describe, test } from 'matchstick-as'

import { handleProtocolFeeTaken, handleProtocolFeeTakenAsClaims } from '../../src/mappings/simHook'
import { Bundle, Pool, Token } from '../../src/types/schema'
import { ProtocolFeeTaken, ProtocolFeeTakenAsClaims } from '../../src/types/templates/SimHook/SimHook'
import { ZERO_BD } from '../../src/utils/constants'
import { convertTokenToDecimal } from '../../src/utils/index'
import { updatePoolDayData, updatePoolHourData } from '../../src/utils/intervalUpdates'
import {
  assertObjectMatches,
  invokePoolCreatedWithMockedEthCalls,
  MOCK_EVENT,
  TEST_CONFIG,
  TEST_ETH_PRICE_USD,
  TEST_USDC_DERIVED_ETH,
  TEST_WETH_DERIVED_ETH,
  USDC_MAINNET_FIXTURE,
  USDC_WETH_POOL_ID,
  WETH_MAINNET_FIXTURE,
} from './constants'

const HOOK = '0x00000000000000000000000000000000000000a0'
const TREASURY = '0x00000000000000000000000000000000000000d0'
const USDC_DECIMALS = BigInt.fromString(USDC_MAINNET_FIXTURE.decimals)
const WETH_DECIMALS = BigInt.fromString(WETH_MAINNET_FIXTURE.decimals)

function takenParams(amount0: BigInt, amount1: BigInt): ethereum.EventParam[] {
  return [
    new ethereum.EventParam('poolId', ethereum.Value.fromFixedBytes(Bytes.fromHexString(USDC_WETH_POOL_ID))),
    new ethereum.EventParam('treasury', ethereum.Value.fromAddress(Address.fromString(TREASURY))),
    new ethereum.EventParam('amount0', ethereum.Value.fromUnsignedBigInt(amount0)),
    new ethereum.EventParam('amount1', ethereum.Value.fromUnsignedBigInt(amount1)),
  ]
}

function createTakenEvent(amount0: BigInt, amount1: BigInt, logIndex: BigInt): ProtocolFeeTaken {
  return new ProtocolFeeTaken(
    Address.fromString(HOOK),
    logIndex,
    MOCK_EVENT.transactionLogIndex,
    MOCK_EVENT.logType,
    MOCK_EVENT.block,
    MOCK_EVENT.transaction,
    takenParams(amount0, amount1),
    MOCK_EVENT.receipt,
  )
}

function createTakenAsClaimsEvent(amount0: BigInt, amount1: BigInt, logIndex: BigInt): ProtocolFeeTakenAsClaims {
  return new ProtocolFeeTakenAsClaims(
    Address.fromString(HOOK),
    logIndex,
    MOCK_EVENT.transactionLogIndex,
    MOCK_EVENT.logType,
    MOCK_EVENT.block,
    MOCK_EVENT.transaction,
    takenParams(amount0, amount1),
    MOCK_EVENT.receipt,
  )
}

// USD value the handler computes: (a0 * derivedETH0 + a1 * derivedETH1) * ethPriceUSD
function valueUSD(amount0Decimal: BigDecimal, amount1Decimal: BigDecimal): BigDecimal {
  const amountETH = amount0Decimal.times(TEST_USDC_DERIVED_ETH).plus(amount1Decimal.times(TEST_WETH_DERIVED_ETH))
  return amountETH.times(TEST_ETH_PRICE_USD)
}

function collectionId(logIndex: BigInt): string {
  return MOCK_EVENT.transaction.hash.toHexString() + '-' + logIndex.toString()
}

describe('handleProtocolFeeTaken', () => {
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

    // on chain the swap in front of the take has already created the period buckets
    const pool = Pool.load(USDC_WETH_POOL_ID)!
    updatePoolDayData(pool, MOCK_EVENT, null)
    updatePoolHourData(pool, MOCK_EVENT, null)
  })

  test('accumulates a token0 take in decimal units and USD at current prices', () => {
    const raw0 = BigInt.fromString('5000000000000000000')
    const amount0 = convertTokenToDecimal(raw0, USDC_DECIMALS)
    const usd = valueUSD(amount0, ZERO_BD)
    const logIndex = BigInt.fromI32(7)

    handleProtocolFeeTaken(createTakenEvent(raw0, BigInt.zero(), logIndex))

    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['ascntProtocolFeesToken0', amount0.toString()],
      ['ascntProtocolFeesToken1', '0'],
      ['ascntProtocolFeesUSD', usd.toString()],
    ])
    const dayId = MOCK_EVENT.block.timestamp.toI32() / 86400
    const hourId = MOCK_EVENT.block.timestamp.toI32() / 3600
    assertObjectMatches('PoolDayData', USDC_WETH_POOL_ID + '-' + dayId.toString(), [
      ['ascntProtocolFeesUSD', usd.toString()],
    ])
    assertObjectMatches('PoolHourData', USDC_WETH_POOL_ID + '-' + hourId.toString(), [
      ['ascntProtocolFeesUSD', usd.toString()],
    ])
    assertObjectMatches('ProtocolFeeCollection', collectionId(logIndex), [
      ['hook', HOOK],
      ['pool', USDC_WETH_POOL_ID],
      ['treasury', TREASURY],
      ['amount0', raw0.toString()],
      ['amount1', '0'],
      ['asClaims', 'false'],
    ])
  })

  test('a token1 take as claims lands on token1, is flagged, and sums with earlier takes', () => {
    const raw0 = BigInt.fromString('5000000000000000000')
    const raw1 = BigInt.fromString('1000000000000000000')
    const amount0 = convertTokenToDecimal(raw0, USDC_DECIMALS)
    const amount1 = convertTokenToDecimal(raw1, WETH_DECIMALS)

    handleProtocolFeeTaken(createTakenEvent(raw0, BigInt.zero(), BigInt.fromI32(7)))
    handleProtocolFeeTakenAsClaims(createTakenAsClaimsEvent(BigInt.zero(), raw1, BigInt.fromI32(9)))

    const usd = valueUSD(amount0, ZERO_BD).plus(valueUSD(ZERO_BD, amount1))
    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['ascntProtocolFeesToken0', amount0.toString()],
      ['ascntProtocolFeesToken1', amount1.toString()],
      ['ascntProtocolFeesUSD', usd.toString()],
    ])
    assertObjectMatches('ProtocolFeeCollection', collectionId(BigInt.fromI32(9)), [
      ['amount0', '0'],
      ['amount1', raw1.toString()],
      ['asClaims', 'true'],
    ])
    assert.entityCount('ProtocolFeeCollection', 2)
  })
})
