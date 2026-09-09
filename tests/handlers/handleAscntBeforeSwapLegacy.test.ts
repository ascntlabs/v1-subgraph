import { BigInt, Bytes, ethereum } from '@graphprotocol/graph-ts'
import { assert, clearStore, describe, test } from 'matchstick-as'

import { handleAscntBeforeSwapLegacyHelper } from '../../src/mappings/ascntLegacy'
import { BeforeSwap } from '../../src/types/CumHookMVPLegacy/CumHookMVPLegacy'
import {
  assertObjectMatches,
  createAndStoreTestPool,
  MOCK_EVENT,
  USDC_WETH_05_MAINNET_POOL_FIXTURE,
  USDC_WETH_POOL_ID,
} from './constants'

class BeforeSwapLegacyFixture {
  poolId: string
  sqrtPriceX96before: string
  illiqBefore: string
  estimatedVolume1: string
  estimatedPriceImpact: string
  decayedCumPriceImpact: string
  dynamicFeePips: i32
  timestamp: string
}

const BEFORE_SWAP_FIXTURE: BeforeSwapLegacyFixture = {
  poolId: USDC_WETH_POOL_ID,
  sqrtPriceX96before: '79228162514264337593543950336', // 1.0 in Q64.96
  illiqBefore: '12345',
  estimatedVolume1: '1000000000000000000', // 1e18
  estimatedPriceImpact: '500000000000000', // 0.0005 in WAD
  decayedCumPriceImpact: '250000000000000',
  dynamicFeePips: 3000,
  timestamp: '1700000000',
}

function createBeforeSwapEvent(fixture: BeforeSwapLegacyFixture): BeforeSwap {
  const poolIdBytes = Bytes.fromHexString(fixture.poolId) as Bytes
  return new BeforeSwap(
    MOCK_EVENT.address,
    MOCK_EVENT.logIndex,
    MOCK_EVENT.transactionLogIndex,
    MOCK_EVENT.logType,
    MOCK_EVENT.block,
    MOCK_EVENT.transaction,
    [
      new ethereum.EventParam('poolId', ethereum.Value.fromFixedBytes(poolIdBytes)),
      new ethereum.EventParam(
        'sqrtPriceX96before',
        ethereum.Value.fromUnsignedBigInt(BigInt.fromString(fixture.sqrtPriceX96before)),
      ),
      new ethereum.EventParam('illiqBefore', ethereum.Value.fromUnsignedBigInt(BigInt.fromString(fixture.illiqBefore))),
      new ethereum.EventParam(
        'estimatedVolume1',
        ethereum.Value.fromUnsignedBigInt(BigInt.fromString(fixture.estimatedVolume1)),
      ),
      new ethereum.EventParam(
        'estimatedPriceImpact',
        ethereum.Value.fromUnsignedBigInt(BigInt.fromString(fixture.estimatedPriceImpact)),
      ),
      new ethereum.EventParam(
        'decayedCumPriceImpact',
        ethereum.Value.fromSignedBigInt(BigInt.fromString(fixture.decayedCumPriceImpact)),
      ),
      new ethereum.EventParam('dynamicFeePips', ethereum.Value.fromI32(fixture.dynamicFeePips)),
      new ethereum.EventParam('timestamp', ethereum.Value.fromUnsignedBigInt(BigInt.fromString(fixture.timestamp))),
    ],
    MOCK_EVENT.receipt,
  )
}

describe('handleAscntBeforeSwapLegacy', () => {
  test('creates SwapStaging with old-shape before-swap fields and updates Pool snapshot', () => {
    clearStore()
    createAndStoreTestPool(USDC_WETH_05_MAINNET_POOL_FIXTURE)

    const event = createBeforeSwapEvent(BEFORE_SWAP_FIXTURE)
    handleAscntBeforeSwapLegacyHelper(event)

    const swapStagingId = MOCK_EVENT.transaction.hash.toHexString() + '-' + BEFORE_SWAP_FIXTURE.poolId

    assertObjectMatches('SwapStaging', swapStagingId, [
      ['pool', BEFORE_SWAP_FIXTURE.poolId],
      ['transaction', MOCK_EVENT.transaction.hash.toHexString()],
      ['sqrtPriceX96Before', BEFORE_SWAP_FIXTURE.sqrtPriceX96before],
      ['illiqBefore', BEFORE_SWAP_FIXTURE.illiqBefore],
      ['estimatedVolume1', BEFORE_SWAP_FIXTURE.estimatedVolume1],
      ['estimatedPriceImpact', BEFORE_SWAP_FIXTURE.estimatedPriceImpact],
      ['decayedCumPriceImpact', BEFORE_SWAP_FIXTURE.decayedCumPriceImpact],
      ['dynamicFeePips', BEFORE_SWAP_FIXTURE.dynamicFeePips.toString()],
    ])

    // swapId is intentionally not set here — handleSwap pairs them later.
    // Matchstick stores nullable unset fields as absent, so we don't assert on it.

    // Pool snapshot also written for "latest before-swap state" queryability
    assertObjectMatches('Pool', BEFORE_SWAP_FIXTURE.poolId, [
      ['sqrtPriceX96Before', BEFORE_SWAP_FIXTURE.sqrtPriceX96before],
      ['dynamicFeePips', BEFORE_SWAP_FIXTURE.dynamicFeePips.toString()],
    ])
  })

  test('returns early when pool does not exist', () => {
    clearStore()

    const event = createBeforeSwapEvent(BEFORE_SWAP_FIXTURE)
    handleAscntBeforeSwapLegacyHelper(event)

    const swapStagingId = MOCK_EVENT.transaction.hash.toHexString() + '-' + BEFORE_SWAP_FIXTURE.poolId
    assert.notInStore('SwapStaging', swapStagingId)
  })
})
