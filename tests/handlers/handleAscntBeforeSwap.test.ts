import { BigInt, Bytes, ethereum } from '@graphprotocol/graph-ts'
import { assert, clearStore, describe, test } from 'matchstick-as'

import { handleAscntBeforeSwapHelper } from '../../src/mappings/ascntBeforeSwap'
import { BeforeSwap } from '../../src/types/SimHookMVPLegacy/SimHookMVPLegacy'
import {
  assertObjectMatches,
  createAndStoreTestPool,
  MOCK_EVENT,
  USDC_WETH_05_MAINNET_POOL_FIXTURE,
  USDC_WETH_POOL_ID,
} from './constants'

class BeforeSwapFixture {
  poolId: string
  sqrtPriceX96Before: string
  sqrtPriceX96AfterSim: string
  priceImpact: string
  decayedCumPriceImpact: string
  effectiveMinFee: i32
  dynamicFeePips: i32
  timestamp: string
}

const BEFORE_SWAP_FIXTURE: BeforeSwapFixture = {
  poolId: USDC_WETH_POOL_ID,
  sqrtPriceX96Before: '79228162514264337593543950336', // 1.0 in Q64.96
  sqrtPriceX96AfterSim: '79228162514264337514315787821',
  priceImpact: '500000000000000', // 0.0005 in WAD — pre-swap simulated impact
  decayedCumPriceImpact: '250000000000000',
  effectiveMinFee: 400,
  dynamicFeePips: 3000,
  timestamp: '1700000000',
}

function createBeforeSwapEvent(fixture: BeforeSwapFixture): BeforeSwap {
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

describe('handleAscntBeforeSwap', () => {
  test('creates SwapStaging with before-swap fields and updates Pool snapshot', () => {
    clearStore()
    createAndStoreTestPool(USDC_WETH_05_MAINNET_POOL_FIXTURE)

    const event = createBeforeSwapEvent(BEFORE_SWAP_FIXTURE)
    handleAscntBeforeSwapHelper(event)

    const swapStagingId = MOCK_EVENT.transaction.hash.toHexString() + '-' + BEFORE_SWAP_FIXTURE.poolId

    assertObjectMatches('SwapStaging', swapStagingId, [
      ['pool', BEFORE_SWAP_FIXTURE.poolId],
      ['transaction', MOCK_EVENT.transaction.hash.toHexString()],
      ['sqrtPriceX96Before', BEFORE_SWAP_FIXTURE.sqrtPriceX96Before],
      // BeforeSwap.priceImpact is the simulated impact — it lands on estimatedPriceImpact
      ['estimatedPriceImpact', BEFORE_SWAP_FIXTURE.priceImpact],
      ['decayedCumPriceImpact', BEFORE_SWAP_FIXTURE.decayedCumPriceImpact],
      ['dynamicFeePips', BEFORE_SWAP_FIXTURE.dynamicFeePips.toString()],
    ])

    // swapId is intentionally not set here — handleSwap pairs them later.
    // Matchstick stores nullable unset fields as absent, so we don't assert on it.

    // Pool snapshot also written for "latest before-swap state" queryability
    assertObjectMatches('Pool', BEFORE_SWAP_FIXTURE.poolId, [
      ['sqrtPriceX96Before', BEFORE_SWAP_FIXTURE.sqrtPriceX96Before],
      ['dynamicFeePips', BEFORE_SWAP_FIXTURE.dynamicFeePips.toString()],
    ])
  })

  test('returns early when pool does not exist', () => {
    clearStore()

    const event = createBeforeSwapEvent(BEFORE_SWAP_FIXTURE)
    handleAscntBeforeSwapHelper(event)

    const swapStagingId = MOCK_EVENT.transaction.hash.toHexString() + '-' + BEFORE_SWAP_FIXTURE.poolId
    assert.notInStore('SwapStaging', swapStagingId)
  })
})
