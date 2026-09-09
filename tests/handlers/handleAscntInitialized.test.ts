import { Address, BigInt, Bytes, ethereum } from '@graphprotocol/graph-ts'
import { assert, beforeEach, clearStore, describe, test } from 'matchstick-as'

import { handleAscntInitializedHelper } from '../../src/mappings/ascntInitialized'
import { PoolInitialized as AscntPoolInitialized } from '../../src/types/SimHookMVPLegacy/SimHookMVPLegacy'
import {
  invokePoolCreatedWithMockedEthCalls,
  MOCK_EVENT,
  TEST_CONFIG,
  USDC_MAINNET_FIXTURE,
  USDC_WETH_POOL_ID,
  WETH_MAINNET_FIXTURE,
} from './constants'

const ASCNT_HOOK_ADDRESS = '0x29d6e0ff868ba37fd81f84208b1bc6781dffb0c0'

// Only event.params.id is read by the handler; other params can be plausible dummies.
function createAscntPoolInitializedEvent(poolId: string): AscntPoolInitialized {
  const poolIdBytes = Bytes.fromHexString(poolId) as Bytes
  return new AscntPoolInitialized(
    MOCK_EVENT.address,
    MOCK_EVENT.logIndex,
    MOCK_EVENT.transactionLogIndex,
    MOCK_EVENT.logType,
    MOCK_EVENT.block,
    MOCK_EVENT.transaction,
    [
      new ethereum.EventParam('id', ethereum.Value.fromFixedBytes(poolIdBytes)),
      new ethereum.EventParam(
        'currency0',
        ethereum.Value.fromAddress(Address.fromString(USDC_MAINNET_FIXTURE.address)),
      ),
      new ethereum.EventParam(
        'currency1',
        ethereum.Value.fromAddress(Address.fromString(WETH_MAINNET_FIXTURE.address)),
      ),
      new ethereum.EventParam('fee', ethereum.Value.fromI32(500)),
      new ethereum.EventParam('tickSpacing', ethereum.Value.fromI32(10)),
      new ethereum.EventParam('hooks', ethereum.Value.fromAddress(Address.fromString(ASCNT_HOOK_ADDRESS))),
      new ethereum.EventParam('sqrtPriceX96', ethereum.Value.fromUnsignedBigInt(BigInt.fromString('1'))),
      new ethereum.EventParam('tick', ethereum.Value.fromI32(1)),
    ],
    MOCK_EVENT.receipt,
  )
}

describe('handleAscntInitialized', () => {
  beforeEach(() => {
    clearStore()
    // Sets up Pool + Tokens + PoolManager via the PoolManager.Initialize path,
    // so the Ascnt handler has the entities it needs to load.
    invokePoolCreatedWithMockedEthCalls(MOCK_EVENT, TEST_CONFIG)
  })

  test('flips Pool.isAscntPool to true and registers in PoolManager.ascntPools', () => {
    // sanity: PoolManager.Initialize left this as a non-Ascnt pool
    assert.fieldEquals('Pool', USDC_WETH_POOL_ID, 'isAscntPool', 'false')
    assert.fieldEquals('PoolManager', TEST_CONFIG.poolManagerAddress, 'ascntPoolCount', '0')

    handleAscntInitializedHelper(createAscntPoolInitializedEvent(USDC_WETH_POOL_ID), TEST_CONFIG)

    assert.fieldEquals('Pool', USDC_WETH_POOL_ID, 'isAscntPool', 'true')
    assert.fieldEquals('PoolManager', TEST_CONFIG.poolManagerAddress, 'ascntPoolCount', '1')
    assert.fieldEquals('PoolManager', TEST_CONFIG.poolManagerAddress, 'ascntPools', '[' + USDC_WETH_POOL_ID + ']')
  })

  test('idempotent: a second firing for the same pool does not double-count', () => {
    const event = createAscntPoolInitializedEvent(USDC_WETH_POOL_ID)
    handleAscntInitializedHelper(event, TEST_CONFIG)
    handleAscntInitializedHelper(event, TEST_CONFIG)

    assert.fieldEquals('Pool', USDC_WETH_POOL_ID, 'isAscntPool', 'true')
    assert.fieldEquals('PoolManager', TEST_CONFIG.poolManagerAddress, 'ascntPoolCount', '1')
  })
})
