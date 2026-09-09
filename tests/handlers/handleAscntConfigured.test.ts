import { BigInt, Bytes, ethereum } from '@graphprotocol/graph-ts'
import { assert, clearStore, describe, test } from 'matchstick-as'

import { handleAscntConfiguredHelper } from '../../src/mappings/ascntConfigured'
import { PoolConfigured } from '../../src/types/SimHookMVPLegacy/SimHookMVPLegacy'
import {
  assertObjectMatches,
  createAndStoreTestPool,
  MOCK_EVENT,
  USDC_WETH_05_MAINNET_POOL_FIXTURE,
  USDC_WETH_POOL_ID,
} from './constants'

class PoolConfiguredFixture {
  poolId: string
  configured: boolean
  minMinFee: i32
  maxMinFee: i32
  maxFee: i32
  fallbackFee: i32
  timeDecayLength: string
  jitLockBlocks: string
  timestamp: string
}

const POOL_CONFIGURED_FIXTURE: PoolConfiguredFixture = {
  poolId: USDC_WETH_POOL_ID,
  configured: true,
  minMinFee: 100,
  maxMinFee: 500,
  maxFee: 10000,
  fallbackFee: 3000,
  timeDecayLength: '86400',
  jitLockBlocks: '5',
  timestamp: '1700000000',
}

function createPoolConfiguredEvent(fixture: PoolConfiguredFixture): PoolConfigured {
  const poolIdBytes = Bytes.fromHexString(fixture.poolId) as Bytes
  return new PoolConfigured(
    MOCK_EVENT.address,
    MOCK_EVENT.logIndex,
    MOCK_EVENT.transactionLogIndex,
    MOCK_EVENT.logType,
    MOCK_EVENT.block,
    MOCK_EVENT.transaction,
    [
      new ethereum.EventParam('poolId', ethereum.Value.fromFixedBytes(poolIdBytes)),
      new ethereum.EventParam('configured', ethereum.Value.fromBoolean(fixture.configured)),
      new ethereum.EventParam('minMinFee', ethereum.Value.fromI32(fixture.minMinFee)),
      new ethereum.EventParam('maxMinFee', ethereum.Value.fromI32(fixture.maxMinFee)),
      new ethereum.EventParam('maxFee', ethereum.Value.fromI32(fixture.maxFee)),
      new ethereum.EventParam('fallbackFee', ethereum.Value.fromI32(fixture.fallbackFee)),
      new ethereum.EventParam(
        'timeDecayLength',
        ethereum.Value.fromUnsignedBigInt(BigInt.fromString(fixture.timeDecayLength)),
      ),
      new ethereum.EventParam(
        'jitLockBlocks',
        ethereum.Value.fromUnsignedBigInt(BigInt.fromString(fixture.jitLockBlocks)),
      ),
      new ethereum.EventParam('timestamp', ethereum.Value.fromUnsignedBigInt(BigInt.fromString(fixture.timestamp))),
    ],
    MOCK_EVENT.receipt,
  )
}

describe('handleAscntConfigured', () => {
  test('writes fee config onto the Pool, mapping minMinFee to minFee', () => {
    clearStore()
    createAndStoreTestPool(USDC_WETH_05_MAINNET_POOL_FIXTURE)

    const event = createPoolConfiguredEvent(POOL_CONFIGURED_FIXTURE)
    handleAscntConfiguredHelper(event)

    assertObjectMatches('Pool', POOL_CONFIGURED_FIXTURE.poolId, [
      ['configured', 'true'],
      ['minFee', POOL_CONFIGURED_FIXTURE.minMinFee.toString()],
      ['maxFee', POOL_CONFIGURED_FIXTURE.maxFee.toString()],
      ['fallbackFee', POOL_CONFIGURED_FIXTURE.fallbackFee.toString()],
      ['timeDecayLength', POOL_CONFIGURED_FIXTURE.timeDecayLength],
    ])
  })

  test('returns early when pool does not exist', () => {
    clearStore()

    const event = createPoolConfiguredEvent(POOL_CONFIGURED_FIXTURE)
    handleAscntConfiguredHelper(event)

    assert.notInStore('Pool', POOL_CONFIGURED_FIXTURE.poolId)
  })
})
