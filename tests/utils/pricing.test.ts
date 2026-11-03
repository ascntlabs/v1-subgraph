import { BigDecimal, BigInt } from '@graphprotocol/graph-ts'
import { assert, clearStore, describe, test } from 'matchstick-as/assembly/index'

import { Bundle, Token } from '../../src/types/schema'
import { ADDRESS_ZERO } from '../../src/utils/constants'
import { calculateAmountUSD, findNativePerToken, PRICING_POOL_FRESH_SECONDS } from '../../src/utils/pricing'
import { sqrtPriceX96ToTokenPrices } from '../../src/utils/pricing'
import {
  createAndStoreTestPool,
  createAndStoreTestToken,
  PoolFixture,
  TEST_CONFIG,
  USDC_MAINNET_FIXTURE,
  WBTC_MAINNET_FIXTURE,
  WETH_MAINNET_FIXTURE,
} from '../handlers/constants'

describe('Price calculations', () => {
  test('calculateAmountUSD calculates correctly', () => {
    const amount0 = BigDecimal.fromString('100')
    const amount1 = BigDecimal.fromString('200')
    const token0DerivedETH = BigDecimal.fromString('0.1')
    const token1DerivedETH = BigDecimal.fromString('0.2')
    const ethPriceUSD = BigDecimal.fromString('1000')

    const result = calculateAmountUSD(amount0, amount1, token0DerivedETH, token1DerivedETH, ethPriceUSD)

    // Expected result: (100 * 0.1 * 1000) + (200 * 0.2 * 1000) = 10000 + 40000 = 50000
    assert.assertTrue(result.equals(BigDecimal.fromString('50000')), 'Result should be 50000')
  })

  test('calculateAmountUSD handles zero amounts', () => {
    const amount0 = BigDecimal.fromString('0')
    const amount1 = BigDecimal.fromString('0')
    const token0DerivedETH = BigDecimal.fromString('0.1')
    const token1DerivedETH = BigDecimal.fromString('0.2')
    const ethPriceUSD = BigDecimal.fromString('1000')

    const result = calculateAmountUSD(amount0, amount1, token0DerivedETH, token1DerivedETH, ethPriceUSD)

    assert.assertTrue(result.equals(BigDecimal.fromString('0')), 'Result should be 0')
  })

  test('calculateAmountUSD handles very large numbers', () => {
    const amount0 = BigDecimal.fromString('1000000000000000000') // 1e18
    const amount1 = BigDecimal.fromString('2000000000000000000') // 2e18
    const token0DerivedETH = BigDecimal.fromString('0.1')
    const token1DerivedETH = BigDecimal.fromString('0.2')
    const ethPriceUSD = BigDecimal.fromString('1000')

    const result = calculateAmountUSD(amount0, amount1, token0DerivedETH, token1DerivedETH, ethPriceUSD)

    // Expected result: (1e18 * 0.1 * 1000) + (2e18 * 0.2 * 1000) = 1e20 + 4e20 = 5e20
    assert.assertTrue(result.equals(BigDecimal.fromString('500000000000000000000')), 'Result should be 5e20')
  })
})

describe('sqrtPriceX96ToTokenPrices', () => {
  test('calculates prices correctly for non-native tokens', () => {
    const token0 = new Token(USDC_MAINNET_FIXTURE.address)
    token0.decimals = BigInt.fromString(USDC_MAINNET_FIXTURE.decimals)

    const token1 = new Token(WETH_MAINNET_FIXTURE.address)
    token1.decimals = BigInt.fromString(WETH_MAINNET_FIXTURE.decimals)

    const sqrtPriceX96 = BigInt.fromString('79228162514264337593543950336') // 1:1 price

    const prices = sqrtPriceX96ToTokenPrices(sqrtPriceX96, token0, token1, TEST_CONFIG.nativeTokenDetails)

    assert.assertTrue(prices[0].equals(BigDecimal.fromString('1')), 'Token0 price should be 1')
    assert.assertTrue(prices[1].equals(BigDecimal.fromString('1')), 'Token1 price should be 1')
  })

  test('calculates prices correctly when token0 is native', () => {
    const token0 = new Token(ADDRESS_ZERO)
    token0.decimals = BigInt.fromI32(0) // This should be ignored

    const token1 = new Token(USDC_MAINNET_FIXTURE.address)
    token1.decimals = BigInt.fromString(USDC_MAINNET_FIXTURE.decimals)

    const sqrtPriceX96 = BigInt.fromString('79228162514264337593543950336') // 1:1 price

    const prices = sqrtPriceX96ToTokenPrices(sqrtPriceX96, token0, token1, TEST_CONFIG.nativeTokenDetails)

    assert.assertTrue(prices[0].equals(BigDecimal.fromString('1')), 'Native token price should be 1')
    assert.assertTrue(prices[1].equals(BigDecimal.fromString('1')), 'USDC price should be 1')
  })

  test('calculates prices correctly when token1 is native', () => {
    const token0 = new Token(USDC_MAINNET_FIXTURE.address)
    token0.decimals = BigInt.fromString(USDC_MAINNET_FIXTURE.decimals)

    const token1 = new Token(ADDRESS_ZERO)
    token1.decimals = BigInt.fromI32(0) // This should be ignored

    const sqrtPriceX96 = BigInt.fromString('79228162514264337593543950336') // 1:1 price

    const prices = sqrtPriceX96ToTokenPrices(sqrtPriceX96, token0, token1, TEST_CONFIG.nativeTokenDetails)

    assert.assertTrue(prices[0].equals(BigDecimal.fromString('1')), 'USDC price should be 1')
    assert.assertTrue(prices[1].equals(BigDecimal.fromString('1')), 'Native token price should be 1')
  })
})

// findNativePerToken: a pool prices a token when it has in-range liquidity and
// twice its whitelisted leg clears the USD floor; among those, the largest pool
// swapped within PRICING_POOL_FRESH_SECONDS wins, else the largest overall.
// Helpers sit at module level: AssemblyScript has no closures.
const POOL_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const POOL_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const NOW = BigInt.fromI32(1700000000)
const ONE_HOUR = BigInt.fromI32(3600)
const DORMANT = NOW.minus(PRICING_POOL_FRESH_SECONDS).minus(ONE_HOUR)
const ETH_USD = BigDecimal.fromString('2000')
const FLOOR_USD = BigDecimal.fromString('1000')

function wbtcWethFixture(id: string): PoolFixture {
  return {
    id,
    token0: WBTC_MAINNET_FIXTURE,
    token1: WETH_MAINNET_FIXTURE,
    feeTier: '3000',
    tickSpacing: '60',
    liquidity: '200',
    hooks: ADDRESS_ZERO,
    sqrtPrice: '1',
    tick: '1',
  }
}

// WBTC is token0 and WETH (derivedETH 1) token1, so the pool's token1Price is
// WBTC's price in ETH and totalValueLockedToken1 is the whitelisted leg.
function storePricingPool(id: string, wethLocked: string, wethPerWbtc: string, lastSwap: BigInt | null): void {
  const pool = createAndStoreTestPool(wbtcWethFixture(id))
  pool.liquidity = BigInt.fromI32(1)
  pool.totalValueLockedToken1 = BigDecimal.fromString(wethLocked)
  pool.token1Price = BigDecimal.fromString(wethPerWbtc)
  pool.lastSwapTimestamp = lastSwap
  pool.save()
}

function setUpPricing(): Token {
  clearStore()
  const bundle = new Bundle('1')
  bundle.ethPriceUSD = ETH_USD
  bundle.save()
  const weth = createAndStoreTestToken(WETH_MAINNET_FIXTURE)
  weth.derivedETH = BigDecimal.fromString('1')
  weth.save()
  const wbtc = createAndStoreTestToken(WBTC_MAINNET_FIXTURE)
  wbtc.whitelistPools = [POOL_A, POOL_B]
  wbtc.save()
  return wbtc
}

function priceOf(token: Token): BigDecimal {
  return findNativePerToken(token, TEST_CONFIG.wrappedNativeAddress, TEST_CONFIG.stablecoinAddresses, FLOOR_USD, NOW)
}

describe('findNativePerToken', () => {
  test('a fresh smaller pool beats a dormant larger one', () => {
    const wbtc = setUpPricing()
    storePricingPool(POOL_A, '10', '20', DORMANT)
    storePricingPool(POOL_B, '1', '15', NOW.minus(ONE_HOUR))
    assert.assertTrue(priceOf(wbtc) == BigDecimal.fromString('15'))
  })

  test('a pool swapped exactly at the window edge is still fresh', () => {
    const wbtc = setUpPricing()
    storePricingPool(POOL_A, '10', '20', DORMANT)
    storePricingPool(POOL_B, '1', '15', NOW.minus(PRICING_POOL_FRESH_SECONDS))
    assert.assertTrue(priceOf(wbtc) == BigDecimal.fromString('15'))
  })

  test('with no fresh pool, the largest qualifying pool prices', () => {
    const wbtc = setUpPricing()
    storePricingPool(POOL_A, '10', '20', DORMANT)
    storePricingPool(POOL_B, '1', '15', DORMANT)
    assert.assertTrue(priceOf(wbtc) == BigDecimal.fromString('20'))
  })

  test('among fresh pools the largest wins', () => {
    const wbtc = setUpPricing()
    storePricingPool(POOL_A, '10', '20', NOW.minus(ONE_HOUR))
    storePricingPool(POOL_B, '1', '15', NOW)
    assert.assertTrue(priceOf(wbtc) == BigDecimal.fromString('20'))
  })

  test('a pool that never swapped is not fresh', () => {
    const wbtc = setUpPricing()
    storePricingPool(POOL_A, '10', '20', DORMANT)
    storePricingPool(POOL_B, '1', '15', null)
    assert.assertTrue(priceOf(wbtc) == BigDecimal.fromString('20'))
  })

  test('a pool under the USD floor never prices, fresh or not', () => {
    const wbtc = setUpPricing()
    // 0.2 ETH leg x $2000 x 2 = $800 < $1000
    storePricingPool(POOL_A, '10', '20', DORMANT)
    storePricingPool(POOL_B, '0.2', '15', NOW)
    assert.assertTrue(priceOf(wbtc) == BigDecimal.fromString('20'))
  })

  test('a leg worth exactly half the floor does not qualify; a hair more does', () => {
    const wbtc = setUpPricing()
    // 0.25 ETH leg x $2000 x 2 = $1000, not above the floor
    storePricingPool(POOL_A, '0.25', '20', NOW)
    storePricingPool(POOL_B, '0.2', '15', NOW)
    assert.assertTrue(priceOf(wbtc) == BigDecimal.fromString('0'))
    storePricingPool(POOL_A, '0.2501', '20', NOW)
    assert.assertTrue(priceOf(wbtc) == BigDecimal.fromString('20'))
  })

  test('a pool with no in-range liquidity is skipped', () => {
    const wbtc = setUpPricing()
    storePricingPool(POOL_A, '10', '20', DORMANT)
    const poolB = createAndStoreTestPool(wbtcWethFixture(POOL_B))
    poolB.liquidity = BigInt.fromI32(0)
    poolB.totalValueLockedToken1 = BigDecimal.fromString('1')
    poolB.token1Price = BigDecimal.fromString('15')
    poolB.lastSwapTimestamp = NOW
    poolB.save()
    assert.assertTrue(priceOf(wbtc) == BigDecimal.fromString('20'))
  })

  test('the floor is measured at the bundle price: no ETH price, no pricing', () => {
    const wbtc = setUpPricing()
    const bundle = Bundle.load('1')!
    bundle.ethPriceUSD = BigDecimal.fromString('0')
    bundle.save()
    storePricingPool(POOL_A, '10', '20', NOW)
    assert.assertTrue(priceOf(wbtc) == BigDecimal.fromString('0'))
  })
})
