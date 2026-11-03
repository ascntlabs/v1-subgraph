import { Address, BigInt, ethereum } from '@graphprotocol/graph-ts'
import { assert, beforeEach, clearStore, describe, test } from 'matchstick-as'

import { ascntAfterSwapCore, ascntBeforeSwapCore, ascntInitializedCore } from '../../src/mappings/ascntCore'
import { handleSubscriberRegistered, handleSubscriberRemovedHelper } from '../../src/mappings/governance'
import { SubscriberRegistered, SubscriberRemoved } from '../../src/types/AscntGovernance/AscntGovernance'
import { Pool } from '../../src/types/schema'
import {
  createAndStoreTestPool,
  invokePoolCreatedWithMockedEthCalls,
  MOCK_EVENT,
  PoolFixture,
  TEST_CONFIG,
  USDC_MAINNET_FIXTURE,
  USDC_WETH_POOL_ID,
  WBTC_WETH_03_MAINNET_POOL_FIXTURE,
  WBTC_WETH_POOL_ID,
  WETH_MAINNET_FIXTURE,
} from './constants'

const HOOK_A = '0x00000000000000000000000000000000000000a0'
const HOOK_B = '0x00000000000000000000000000000000000000b0'
const HOOK_C = '0x00000000000000000000000000000000000000c0'

const THIRD_POOL_ID = '0x1111111111111111111111111111111111111111111111111111111111111111'
const THIRD_POOL_FIXTURE: PoolFixture = {
  id: THIRD_POOL_ID,
  token0: USDC_MAINNET_FIXTURE,
  token1: WETH_MAINNET_FIXTURE,
  feeTier: '500',
  tickSpacing: '10',
  liquidity: '0',
  hooks: HOOK_A,
  sqrtPrice: '1',
  tick: '1',
}

const BLOCK_NUMBER = MOCK_EVENT.block.number.toString()
const BLOCK_TIMESTAMP = MOCK_EVENT.block.timestamp.toString()

// Both governance events carry a single `hook` param.
function hookParams(hook: string): ethereum.EventParam[] {
  return [new ethereum.EventParam('hook', ethereum.Value.fromAddress(Address.fromString(hook)))]
}

function createSubscriberRegisteredEvent(hook: string): SubscriberRegistered {
  return new SubscriberRegistered(
    MOCK_EVENT.address,
    MOCK_EVENT.logIndex,
    MOCK_EVENT.transactionLogIndex,
    MOCK_EVENT.logType,
    MOCK_EVENT.block,
    MOCK_EVENT.transaction,
    hookParams(hook),
    MOCK_EVENT.receipt,
  )
}

function createSubscriberRemovedEvent(hook: string): SubscriberRemoved {
  return new SubscriberRemoved(
    MOCK_EVENT.address,
    MOCK_EVENT.logIndex,
    MOCK_EVENT.transactionLogIndex,
    MOCK_EVENT.logType,
    MOCK_EVENT.block,
    MOCK_EVENT.transaction,
    hookParams(hook),
    MOCK_EVENT.receipt,
  )
}

// Points an already-stored pool at `hook` and runs the Ascnt init path for it.
function initAscntPoolOnHook(poolId: string, hook: string): void {
  const pool = Pool.load(poolId)!
  pool.hooks = hook
  pool.save()
  ascntInitializedCore(poolId, TEST_CONFIG)
}

describe('handleSubscriberRemoved', () => {
  beforeEach(() => {
    clearStore()
    // Pool + Tokens + PoolManager via PoolManager.Initialize; the second pool
    // only needs the entity, so use the light fixture.
    invokePoolCreatedWithMockedEthCalls(MOCK_EVENT, TEST_CONFIG)
    createAndStoreTestPool(WBTC_WETH_03_MAINNET_POOL_FIXTURE)

    handleSubscriberRegistered(createSubscriberRegisteredEvent(HOOK_A))
    handleSubscriberRegistered(createSubscriberRegisteredEvent(HOOK_B))
    initAscntPoolOnHook(USDC_WETH_POOL_ID, HOOK_A)
    initAscntPoolOnHook(WBTC_WETH_POOL_ID, HOOK_B)
  })

  test("clears isAscntPool on the removed hook's pools and drops them from PoolManager", () => {
    assert.fieldEquals('PoolManager', TEST_CONFIG.poolManagerAddress, 'ascntPoolCount', '2')

    handleSubscriberRemovedHelper(createSubscriberRemovedEvent(HOOK_A), TEST_CONFIG)

    assert.fieldEquals('Hook', HOOK_A, 'isSubscriber', 'false')
    assert.fieldEquals('Hook', HOOK_A, 'subscriberRemovedAtBlock', BLOCK_NUMBER)
    assert.fieldEquals('Hook', HOOK_A, 'subscriberRemovedAtTimestamp', BLOCK_TIMESTAMP)

    assert.fieldEquals('Pool', USDC_WETH_POOL_ID, 'isAscntPool', 'false')
    assert.fieldEquals('Pool', USDC_WETH_POOL_ID, 'ascntRemovedAtBlock', BLOCK_NUMBER)
    assert.fieldEquals('Pool', USDC_WETH_POOL_ID, 'ascntRemovedAtTimestamp', BLOCK_TIMESTAMP)

    assert.fieldEquals('PoolManager', TEST_CONFIG.poolManagerAddress, 'ascntPoolCount', '1')
    assert.fieldEquals('PoolManager', TEST_CONFIG.poolManagerAddress, 'ascntPools', '[' + WBTC_WETH_POOL_ID + ']')
  })

  test('leaves pools on other hooks untouched', () => {
    handleSubscriberRemovedHelper(createSubscriberRemovedEvent(HOOK_A), TEST_CONFIG)

    assert.fieldEquals('Hook', HOOK_B, 'isSubscriber', 'true')
    assert.fieldEquals('Pool', WBTC_WETH_POOL_ID, 'isAscntPool', 'true')
    const wbtc = Pool.load(WBTC_WETH_POOL_ID)!
    assert.assertTrue(wbtc.ascntRemovedAtBlock === null)
  })

  test('removal of a hook with no pools only flips the Hook entity', () => {
    handleSubscriberRemovedHelper(createSubscriberRemovedEvent(HOOK_C), TEST_CONFIG)

    assert.fieldEquals('Hook', HOOK_C, 'isSubscriber', 'false')
    assert.fieldEquals('Hook', HOOK_C, 'subscriberRemovedAtBlock', BLOCK_NUMBER)
    assert.fieldEquals('PoolManager', TEST_CONFIG.poolManagerAddress, 'ascntPoolCount', '2')
  })

  test('idempotent: a second removal for the same hook changes nothing', () => {
    handleSubscriberRemovedHelper(createSubscriberRemovedEvent(HOOK_A), TEST_CONFIG)
    handleSubscriberRemovedHelper(createSubscriberRemovedEvent(HOOK_A), TEST_CONFIG)

    assert.fieldEquals('PoolManager', TEST_CONFIG.poolManagerAddress, 'ascntPoolCount', '1')
    assert.fieldEquals('PoolManager', TEST_CONFIG.poolManagerAddress, 'ascntPools', '[' + WBTC_WETH_POOL_ID + ']')
  })

  test("stops the Ascnt swap overlay for the removed hook's pools", () => {
    handleSubscriberRemovedHelper(createSubscriberRemovedEvent(HOOK_A), TEST_CONFIG)

    // Both cores return before touching the store: no staging row, and not
    // even the Transaction entity that loadTransaction would create.
    ascntBeforeSwapCore(
      MOCK_EVENT,
      USDC_WETH_POOL_ID,
      BigInt.fromI32(1),
      BigInt.fromI32(2),
      BigInt.fromI32(3),
      BigInt.fromI32(4),
    )
    ascntAfterSwapCore(MOCK_EVENT, USDC_WETH_POOL_ID, BigInt.fromI32(5), BigInt.fromI32(6))

    assert.entityCount('SwapStaging', 0)
    assert.entityCount('Transaction', 0)
    const usdc = Pool.load(USDC_WETH_POOL_ID)!
    assert.assertTrue(usdc.estimatedPriceImpact === null)
    assert.assertTrue(usdc.priceImpact === null)

    // control: a pool on a still-subscribed hook keeps staging
    ascntBeforeSwapCore(
      MOCK_EVENT,
      WBTC_WETH_POOL_ID,
      BigInt.fromI32(1),
      BigInt.fromI32(2),
      BigInt.fromI32(3),
      BigInt.fromI32(4),
    )
    assert.entityCount('SwapStaging', 1)
  })

  test('a new pool initialised on a removed hook never becomes an Ascnt pool', () => {
    handleSubscriberRemovedHelper(createSubscriberRemovedEvent(HOOK_A), TEST_CONFIG)

    createAndStoreTestPool(THIRD_POOL_FIXTURE)
    initAscntPoolOnHook(THIRD_POOL_ID, HOOK_A)

    assert.fieldEquals('Pool', THIRD_POOL_ID, 'isAscntPool', 'false')
    assert.fieldEquals('PoolManager', TEST_CONFIG.poolManagerAddress, 'ascntPoolCount', '1')
    assert.fieldEquals('PoolManager', TEST_CONFIG.poolManagerAddress, 'ascntPools', '[' + WBTC_WETH_POOL_ID + ']')
  })
})
