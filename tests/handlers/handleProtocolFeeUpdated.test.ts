import { Bytes, ethereum } from '@graphprotocol/graph-ts'
import { assert, beforeAll, clearStore, describe, test } from 'matchstick-as'

import { handleProtocolFeeUpdated } from '../../src/mappings/protocolFee'
import { ProtocolFeeUpdated } from '../../src/types/PoolManager/PoolManager'
import {
  assertObjectMatches,
  invokePoolCreatedWithMockedEthCalls,
  MOCK_EVENT,
  TEST_CONFIG,
  USDC_WETH_POOL_ID,
} from './constants'

function createProtocolFeeUpdatedEvent(poolId: string, packedProtocolFee: i32): ProtocolFeeUpdated {
  return new ProtocolFeeUpdated(
    MOCK_EVENT.address,
    MOCK_EVENT.logIndex,
    MOCK_EVENT.transactionLogIndex,
    MOCK_EVENT.logType,
    MOCK_EVENT.block,
    MOCK_EVENT.transaction,
    [
      new ethereum.EventParam('id', ethereum.Value.fromFixedBytes(Bytes.fromHexString(poolId))),
      new ethereum.EventParam('protocolFee', ethereum.Value.fromI32(packedProtocolFee)),
    ],
    MOCK_EVENT.receipt,
  )
}

describe('handleProtocolFeeUpdated', () => {
  beforeAll(() => {
    clearStore()
    invokePoolCreatedWithMockedEthCalls(MOCK_EVENT, TEST_CONFIG)
  })

  test('unpacks the per-direction rates (low 12 bits zeroForOne, high 12 bits oneForZero)', () => {
    // mainnet ETH/MORPHO: 499 pips both ways = 499 | (499 << 12)
    handleProtocolFeeUpdated(createProtocolFeeUpdatedEvent(USDC_WETH_POOL_ID, 2044403))
    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['uniswapProtocolFeeZeroForOne', '499'],
      ['uniswapProtocolFeeOneForZero', '499'],
    ])

    // asymmetric: 100 | (200 << 12)
    handleProtocolFeeUpdated(createProtocolFeeUpdatedEvent(USDC_WETH_POOL_ID, 819300))
    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['uniswapProtocolFeeZeroForOne', '100'],
      ['uniswapProtocolFeeOneForZero', '200'],
    ])

    // switched off again
    handleProtocolFeeUpdated(createProtocolFeeUpdatedEvent(USDC_WETH_POOL_ID, 0))
    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['uniswapProtocolFeeZeroForOne', '0'],
      ['uniswapProtocolFeeOneForZero', '0'],
    ])
  })

  test('ignores pools the subgraph does not track', () => {
    const unknownPool = '0x' + 'ab'.repeat(32)
    handleProtocolFeeUpdated(createProtocolFeeUpdatedEvent(unknownPool, 2044403))
    assert.entityCount('Pool', 1)
  })
})
