import { Address, BigDecimal, BigInt, Bytes, ethereum } from '@graphprotocol/graph-ts'
import { afterEach, assert, beforeEach, clearStore, describe, test } from 'matchstick-as'

import { handleAscntInitializedLegacyHelper } from '../../src/mappings/ascntLegacy'
import { handleInitializeHelper } from '../../src/mappings/poolManager'
import { PoolInitialized as LegacyPoolInitialized } from '../../src/types/CumHookMVPLegacy/CumHookMVPLegacy'
import { Initialize } from '../../src/types/PoolManager/PoolManager'
import { Bundle, Pool } from '../../src/types/schema'
import { ADDRESS_ZERO } from '../../src/utils/constants'
import { loadOrCreateHook } from '../../src/utils/hookEntity'
import { safeDiv } from '../../src/utils/index'
import { findNativePerToken, getNativePriceInUSD, sqrtPriceX96ToTokenPrices } from '../../src/utils/pricing'
import {
  assertObjectMatches,
  createAndStoreTestPool,
  createAndStoreTestToken,
  MOCK_EVENT,
  NATIVE_TOKEN_FIXTURE,
  TEST_CONFIG,
  TEST_ETH_PRICE_USD,
  USDC_MAINNET_FIXTURE,
  USDC_WETH_05_MAINNET_POOL_FIXTURE,
  USDC_WETH_POOL_ID,
  WBTC_MAINNET_FIXTURE,
  WBTC_WETH_03_MAINNET_POOL_FIXTURE,
  WBTC_WETH_POOL_ID,
  WETH_MAINNET_FIXTURE,
} from './constants'

class InitializeFixture {
  id: string
  currency0: string
  currency1: string
  fee: string
  tickSpacing: string
  hooks: string
  sqrtPriceX96: string
  tick: string
}

const ASCNT_HOOK_ADDRESS = '0x29d6e0ff868ba37fd81f84208b1bc6781dffb0c0'
const FACTORY_HOOK_ADDRESS = '0xbf9828455cdc5f02771536e3ecb3c0f931eabec4'
const THIRD_PARTY_HOOK_ADDRESS = '0x0000000000000000000000000000000000000ac0'

/** Uniswap v4 `uint24` fee value reserved for dynamic-fee pools. */
const DYNAMIC_FEE_TIER = '8388608'

const INITIALIZE_FIXTURE: InitializeFixture = {
  id: USDC_WETH_POOL_ID,
  currency0: USDC_MAINNET_FIXTURE.address,
  currency1: WETH_MAINNET_FIXTURE.address,
  fee: '500',
  tickSpacing: '10',
  hooks: ADDRESS_ZERO,
  sqrtPriceX96: '1',
  tick: '1',
}

const id = Bytes.fromHexString(USDC_WETH_POOL_ID) as Bytes

function createInitializeEvent(hooks: string, fee: string = INITIALIZE_FIXTURE.fee): Initialize {
  return new Initialize(
    MOCK_EVENT.address,
    MOCK_EVENT.logIndex,
    MOCK_EVENT.transactionLogIndex,
    MOCK_EVENT.logType,
    MOCK_EVENT.block,
    MOCK_EVENT.transaction,
    [
      new ethereum.EventParam('id', ethereum.Value.fromFixedBytes(id)),
      new ethereum.EventParam(
        'currency0',
        ethereum.Value.fromAddress(Address.fromString(INITIALIZE_FIXTURE.currency0)),
      ),
      new ethereum.EventParam(
        'currency1',
        ethereum.Value.fromAddress(Address.fromString(INITIALIZE_FIXTURE.currency1)),
      ),
      new ethereum.EventParam('fee', ethereum.Value.fromI32(parseInt(fee) as i32)),
      new ethereum.EventParam('tickSpacing', ethereum.Value.fromI32(parseInt(INITIALIZE_FIXTURE.tickSpacing) as i32)),
      new ethereum.EventParam('hooks', ethereum.Value.fromAddress(Address.fromString(hooks))),
      new ethereum.EventParam(
        'sqrtPriceX96',
        ethereum.Value.fromUnsignedBigInt(BigInt.fromString(INITIALIZE_FIXTURE.sqrtPriceX96)),
      ),
      new ethereum.EventParam('tick', ethereum.Value.fromI32(parseInt(INITIALIZE_FIXTURE.tick) as i32)),
    ],
    MOCK_EVENT.receipt,
  )
}

const INITIALIZE_EVENT = createInitializeEvent(INITIALIZE_FIXTURE.hooks)

describe('handleInitialize', () => {
  test('success', () => {
    createAndStoreTestPool(USDC_WETH_05_MAINNET_POOL_FIXTURE)

    const token0 = createAndStoreTestToken(USDC_MAINNET_FIXTURE)
    const token1 = createAndStoreTestToken(WETH_MAINNET_FIXTURE)

    const bundle = new Bundle('1')
    bundle.ethPriceUSD = TEST_ETH_PRICE_USD
    bundle.save()

    handleInitializeHelper(INITIALIZE_EVENT, TEST_CONFIG)
    const expectedPrices = sqrtPriceX96ToTokenPrices(
      BigInt.fromString(INITIALIZE_FIXTURE.sqrtPriceX96),
      token0,
      token1,
      TEST_CONFIG.nativeTokenDetails,
    )

    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['token0', token0.id],
      ['token1', token1.id],
      ['feeTier', INITIALIZE_FIXTURE.fee],
      ['tickSpacing', INITIALIZE_FIXTURE.tickSpacing],
      ['hooks', INITIALIZE_FIXTURE.hooks],
      ['sqrtPrice', INITIALIZE_FIXTURE.sqrtPriceX96],
      ['tick', INITIALIZE_FIXTURE.tick],
      ['createdAtTimestamp', MOCK_EVENT.block.timestamp.toString()],
      ['createdAtBlockNumber', MOCK_EVENT.block.number.toString()],
      ['token0Price', expectedPrices[0].toString()],
      ['token1Price', expectedPrices[1].toString()],
      ['isAscntPool', 'false'],
      ['isDynamicFee', 'false'],
      // v4-core initialises pools without a protocol fee; ProtocolFeeUpdated sets it
      ['uniswapProtocolFeeZeroForOne', '0'],
      ['uniswapProtocolFeeOneForZero', '0'],
      // last-swap rates hold a static pool's tier from the start
      ['poolFee', INITIALIZE_FIXTURE.fee],
      ['lpFee', INITIALIZE_FIXTURE.fee],
      ['ascntProtocolFee', '0'],
      ['totalSwapFee', INITIALIZE_FIXTURE.fee],
      ['lpFeesUSD', '0'],
      ['lpFeesToken0', '0'],
      ['lpFeesToken1', '0'],
      ['uniswapProtocolFeesUSD', '0'],
      ['uniswapProtocolFeesToken0', '0'],
      ['uniswapProtocolFeesToken1', '0'],
      ['ascntProtocolFeesUSD', '0'],
      ['ascntProtocolFeesToken0', '0'],
      ['ascntProtocolFeesToken1', '0'],
    ])

    const expectedEthPrice = getNativePriceInUSD(USDC_WETH_POOL_ID, true)
    assertObjectMatches('Bundle', '1', [['ethPriceUSD', expectedEthPrice.toString()]])

    const expectedToken0Price = findNativePerToken(
      token0,
      TEST_CONFIG.wrappedNativeAddress,
      TEST_CONFIG.stablecoinAddresses,
      TEST_CONFIG.minimumUSDLocked,
      MOCK_EVENT.block.timestamp,
    )
    assertObjectMatches('Token', USDC_MAINNET_FIXTURE.address, [['derivedETH', expectedToken0Price.toString()]])

    const expectedToken1Price = findNativePerToken(
      token1,
      TEST_CONFIG.wrappedNativeAddress,
      TEST_CONFIG.stablecoinAddresses,
      TEST_CONFIG.minimumUSDLocked,
      MOCK_EVENT.block.timestamp,
    )
    assertObjectMatches('Token', WETH_MAINNET_FIXTURE.address, [['derivedETH', expectedToken1Price.toString()]])
  })

  test('leaves isAscntPool=false on an unlisted Ascnt hook — flag is set by handleAscntInitialized', () => {
    clearStore()

    createAndStoreTestPool(USDC_WETH_05_MAINNET_POOL_FIXTURE)
    createAndStoreTestToken(USDC_MAINNET_FIXTURE)
    createAndStoreTestToken(WETH_MAINNET_FIXTURE)

    const bundle = new Bundle('1')
    bundle.ethPriceUSD = TEST_ETH_PRICE_USD
    bundle.save()

    const ascntHookInitializeEvent = createInitializeEvent(ASCNT_HOOK_ADDRESS)
    handleInitializeHelper(ascntHookInitializeEvent, TEST_CONFIG)

    // With the hook absent from legacyHookAddresses, handleInitialize doesn't gate on hook
    // address — the hook's PoolInitialized handler is what flips isAscntPool to true.
    // See handleAscntInitialized.test.ts; the legacy-list path is tested below.
    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['isAscntPool', 'false'],
      ['isDynamicFee', 'false'],
    ])
  })

  test('sets isDynamicFee true when fee tier is dynamic-fee sentinel (ascnt hook)', () => {
    clearStore()

    createAndStoreTestPool(USDC_WETH_05_MAINNET_POOL_FIXTURE)
    createAndStoreTestToken(USDC_MAINNET_FIXTURE)
    createAndStoreTestToken(WETH_MAINNET_FIXTURE)

    const bundle = new Bundle('1')
    bundle.ethPriceUSD = TEST_ETH_PRICE_USD
    bundle.save()

    const event = createInitializeEvent(ASCNT_HOOK_ADDRESS, DYNAMIC_FEE_TIER)
    handleInitializeHelper(event, TEST_CONFIG)

    // isAscntPool is asserted in handleAscntInitialized.test.ts; this test only covers
    // the fee-tier → isDynamicFee derivation, which lives in handleInitialize.
    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['feeTier', DYNAMIC_FEE_TIER],
      // the flag is not a rate: last-swap rates stay 0 until the first swap
      ['poolFee', '0'],
      ['lpFee', '0'],
      ['totalSwapFee', '0'],
      ['isDynamicFee', 'true'],
    ])
  })

  test('sets isDynamicFee false for other fee tiers', () => {
    clearStore()

    createAndStoreTestPool(USDC_WETH_05_MAINNET_POOL_FIXTURE)
    createAndStoreTestToken(USDC_MAINNET_FIXTURE)
    createAndStoreTestToken(WETH_MAINNET_FIXTURE)

    const bundle = new Bundle('1')
    bundle.ethPriceUSD = TEST_ETH_PRICE_USD
    bundle.save()

    const fee3000Event = createInitializeEvent(ADDRESS_ZERO, '3000')
    handleInitializeHelper(fee3000Event, TEST_CONFIG)

    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [['isDynamicFee', 'false']])
  })
})

describe('getEthPriceInUSD', () => {
  beforeEach(() => {
    clearStore()
    createAndStoreTestPool(USDC_WETH_05_MAINNET_POOL_FIXTURE)
  })

  test('success - stablecoin is token0', () => {
    const pool = Pool.load(USDC_WETH_POOL_ID)!
    pool.token0Price = BigDecimal.fromString('1')
    pool.save()

    const ethPriceUSD = getNativePriceInUSD(USDC_WETH_POOL_ID, true)

    assert.assertTrue(ethPriceUSD == BigDecimal.fromString('1'))
  })

  test('success - stablecoin is token1', () => {
    const pool = Pool.load(USDC_WETH_POOL_ID)!
    pool.token1Price = BigDecimal.fromString('1')
    pool.save()

    const ethPriceUSD = getNativePriceInUSD(USDC_WETH_POOL_ID, false)

    assert.assertTrue(ethPriceUSD == BigDecimal.fromString('1'))
  })

  test('failure - pool not found', () => {
    const pool = Pool.load(USDC_WETH_POOL_ID)!
    pool.token0Price = BigDecimal.fromString('1')
    pool.token1Price = BigDecimal.fromString('1')
    pool.save()

    const ethPriceUSD = getNativePriceInUSD(ADDRESS_ZERO, true)
    assert.assertTrue(ethPriceUSD == BigDecimal.fromString('0'))
  })
})

describe('findNativePerToken', () => {
  beforeEach(() => {
    clearStore()

    const bundle = new Bundle('1')
    bundle.ethPriceUSD = TEST_ETH_PRICE_USD
    bundle.save()
  })

  test('success - token is wrapped native', () => {
    const token = createAndStoreTestToken(WETH_MAINNET_FIXTURE)
    const ethPerToken = findNativePerToken(
      token,
      TEST_CONFIG.wrappedNativeAddress,
      TEST_CONFIG.stablecoinAddresses,
      TEST_CONFIG.minimumUSDLocked,
      MOCK_EVENT.block.timestamp,
    )
    assert.assertTrue(ethPerToken == BigDecimal.fromString('1'))
  })

  test('success - token is native', () => {
    const token = createAndStoreTestToken(NATIVE_TOKEN_FIXTURE)
    const ethPerToken = findNativePerToken(
      token,
      TEST_CONFIG.wrappedNativeAddress,
      TEST_CONFIG.stablecoinAddresses,
      TEST_CONFIG.minimumUSDLocked,
      MOCK_EVENT.block.timestamp,
    )
    assert.assertTrue(ethPerToken == BigDecimal.fromString('1'))
  })

  test('success - token is stablecoin', () => {
    const token = createAndStoreTestToken(USDC_MAINNET_FIXTURE)
    const ethPerToken = findNativePerToken(
      token,
      TEST_CONFIG.wrappedNativeAddress,
      TEST_CONFIG.stablecoinAddresses,
      TEST_CONFIG.minimumUSDLocked,
      MOCK_EVENT.block.timestamp,
    )
    const expectedStablecoinPrice = safeDiv(BigDecimal.fromString('1'), TEST_ETH_PRICE_USD)
    assert.assertTrue(ethPerToken == expectedStablecoinPrice)
  })

  test('success - token is not wrapped native or stablecoin', () => {
    const pool = createAndStoreTestPool(WBTC_WETH_03_MAINNET_POOL_FIXTURE)

    const minimumEthLocked = BigDecimal.fromString('0')

    pool.liquidity = BigInt.fromString('100')
    pool.totalValueLockedToken1 = BigDecimal.fromString('100')
    pool.token1Price = BigDecimal.fromString('5')
    pool.save()

    const token0 = createAndStoreTestToken(WBTC_MAINNET_FIXTURE)
    token0.whitelistPools = [WBTC_WETH_POOL_ID]
    token0.save()

    const token1 = createAndStoreTestToken(WETH_MAINNET_FIXTURE)
    token1.derivedETH = BigDecimal.fromString('10')
    token1.save()

    const ethPerToken = findNativePerToken(
      token0,
      WETH_MAINNET_FIXTURE.address,
      [USDC_MAINNET_FIXTURE.address],
      minimumEthLocked,
      MOCK_EVENT.block.timestamp,
    )

    assert.assertTrue(ethPerToken == BigDecimal.fromString('50'))
  })

  test('success - token is not wrapped native or stablecoin, but has no pools', () => {
    const token0 = createAndStoreTestToken(WBTC_MAINNET_FIXTURE)
    const ethPerToken = findNativePerToken(
      token0,
      TEST_CONFIG.wrappedNativeAddress,
      TEST_CONFIG.stablecoinAddresses,
      TEST_CONFIG.minimumUSDLocked,
      MOCK_EVENT.block.timestamp,
    )
    assert.assertTrue(ethPerToken == BigDecimal.fromString('0'))
  })

  test('success - token is not wrapped native or stablecoin, but has no pools with liquidity', () => {
    const token0 = createAndStoreTestToken(WBTC_MAINNET_FIXTURE)
    token0.whitelistPools = [WBTC_WETH_POOL_ID]
    token0.save()

    const ethPerToken = findNativePerToken(
      token0,
      TEST_CONFIG.wrappedNativeAddress,
      TEST_CONFIG.stablecoinAddresses,
      TEST_CONFIG.minimumUSDLocked,
      MOCK_EVENT.block.timestamp,
    )
    assert.assertTrue(ethPerToken == BigDecimal.fromString('0'))
  })
})

// Only event.params.id is read by the legacy handler; the rest are plausible dummies.
function createLegacyPoolInitializedEvent(poolId: string): LegacyPoolInitialized {
  const poolIdBytes = Bytes.fromHexString(poolId) as Bytes
  return new LegacyPoolInitialized(
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

function storeInitializeFixtures(): void {
  clearStore()
  createAndStoreTestPool(USDC_WETH_05_MAINNET_POOL_FIXTURE)
  createAndStoreTestToken(USDC_MAINNET_FIXTURE)
  createAndStoreTestToken(WETH_MAINNET_FIXTURE)
  const bundle = new Bundle('1')
  bundle.ethPriceUSD = TEST_ETH_PRICE_USD
  bundle.save()
}

describe('handleInitialize links Pool.hook', () => {
  beforeEach(() => {
    storeInitializeFixtures()
  })

  afterEach(() => {
    TEST_CONFIG.legacyHookAddresses = []
  })

  test('legacy hook: creates the Hook deprecated + legacy and flags the pool an Ascnt pool at Initialize', () => {
    TEST_CONFIG.legacyHookAddresses = [ASCNT_HOOK_ADDRESS]
    handleInitializeHelper(createInitializeEvent(ASCNT_HOOK_ADDRESS), TEST_CONFIG)

    assertObjectMatches('Hook', ASCNT_HOOK_ADDRESS, [
      ['deprecated', 'true'],
      ['legacy', 'true'],
      ['factory', ADDRESS_ZERO],
      ['isSubscriber', 'false'],
      ['createdAtBlockNumber', MOCK_EVENT.block.number.toString()],
    ])
    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['hook', ASCNT_HOOK_ADDRESS],
      ['isAscntPool', 'true'],
    ])
    assertObjectMatches('PoolManager', TEST_CONFIG.poolManagerAddress, [
      ['ascntPoolCount', '1'],
      ['ascntPools', '[' + USDC_WETH_POOL_ID + ']'],
    ])
  })

  test('legacy hook: the PoolInitialized the hook emits afterwards does not count the pool twice', () => {
    TEST_CONFIG.legacyHookAddresses = [ASCNT_HOOK_ADDRESS]
    handleInitializeHelper(createInitializeEvent(ASCNT_HOOK_ADDRESS), TEST_CONFIG)
    handleAscntInitializedLegacyHelper(createLegacyPoolInitializedEvent(USDC_WETH_POOL_ID), TEST_CONFIG)

    assertObjectMatches('PoolManager', TEST_CONFIG.poolManagerAddress, [
      ['ascntPoolCount', '1'],
      ['ascntPools', '[' + USDC_WETH_POOL_ID + ']'],
    ])
  })

  test('factory hook: links the Hook entity HookDeployed created, flags nothing', () => {
    loadOrCreateHook(Address.fromString(FACTORY_HOOK_ADDRESS), MOCK_EVENT)
    handleInitializeHelper(createInitializeEvent(FACTORY_HOOK_ADDRESS), TEST_CONFIG)

    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['hook', FACTORY_HOOK_ADDRESS],
      ['isAscntPool', 'false'],
    ])
    assertObjectMatches('Hook', FACTORY_HOOK_ADDRESS, [
      ['deprecated', 'false'],
      ['legacy', 'false'],
    ])
  })

  test('third-party hook: no Hook entity is made up and Pool.hook stays null', () => {
    handleInitializeHelper(createInitializeEvent(THIRD_PARTY_HOOK_ADDRESS), TEST_CONFIG)

    const pool = Pool.load(USDC_WETH_POOL_ID)!
    assert.assertTrue(pool.hook === null)
    assert.fieldEquals('Pool', USDC_WETH_POOL_ID, 'isAscntPool', 'false')
    assert.notInStore('Hook', THIRD_PARTY_HOOK_ADDRESS)
  })
})
