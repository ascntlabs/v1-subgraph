import { BigDecimal, BigInt } from '@graphprotocol/graph-ts'

import { exponentToBigDecimal, safeDiv } from '../utils/index'
import { Bundle, Pool, Token } from './../types/schema'
import { ADDRESS_ZERO, ONE_BD, ZERO_BD, ZERO_BI } from './constants'
import { NativeTokenDetails } from './nativeTokenDetails'

const Q192 = BigInt.fromI32(2).pow(192 as u8)
export function sqrtPriceX96ToTokenPrices(
  sqrtPriceX96: BigInt,
  token0: Token,
  token1: Token,
  nativeTokenDetails: NativeTokenDetails,
): BigDecimal[] {
  const token0Decimals = token0.id == ADDRESS_ZERO ? nativeTokenDetails.decimals : token0.decimals
  const token1Decimals = token1.id == ADDRESS_ZERO ? nativeTokenDetails.decimals : token1.decimals

  const num = sqrtPriceX96.times(sqrtPriceX96).toBigDecimal()
  const denom = BigDecimal.fromString(Q192.toString())
  const decimalScale = exponentToBigDecimal(token0Decimals).div(exponentToBigDecimal(token1Decimals))
  const price1 = num.div(denom).times(decimalScale)

  const price0 = safeDiv(BigDecimal.fromString('1'), price1)
  return [price0, price1]
}

export function getNativePriceInUSD(stablecoinWrappedNativePoolId: string, stablecoinIsToken0: boolean): BigDecimal {
  const stablecoinWrappedNativePool = Pool.load(stablecoinWrappedNativePoolId)
  if (stablecoinWrappedNativePool !== null) {
    return stablecoinIsToken0 ? stablecoinWrappedNativePool.token0Price : stablecoinWrappedNativePool.token1Price
  } else {
    return ZERO_BD
  }
}

// A pricing pool is fresh when it swapped within this window. Among the pools
// that clear the floor, the largest fresh one prices the token; only when none
// is fresh does the largest overall. So a deep pool that has gone quiet cannot
// hold a token at a stale price while a smaller pool trades it every hour.
export const PRICING_POOL_FRESH_SECONDS = BigInt.fromI32(86400)

const TWO_BD = BigDecimal.fromString('2')

/**
 * Native (ETH) price of a token from its whitelist pools: a pool's spot times the
 * paired whitelisted token's own derivedETH. A pool qualifies when it has in-range
 * liquidity and twice its whitelisted leg, valued at the bundle's native price,
 * exceeds minimumUSDLocked (the leg stands in for half the pool, as tracked volume
 * does). Pools are read from the store, so the caller must have saved the pool it
 * just changed. README "Token pricing".
 **/
export function findNativePerToken(
  token: Token,
  wrappedNativeAddress: string,
  stablecoinAddresses: string[],
  minimumUSDLocked: BigDecimal,
  timestamp: BigInt,
): BigDecimal {
  if (token.id == wrappedNativeAddress || token.id == ADDRESS_ZERO) {
    return ONE_BD
  }
  const bundle = Bundle.load('1')!

  // hardcoded fix for incorrect rates
  // if whitelist includes token - get the safe price
  if (stablecoinAddresses.includes(token.id)) {
    return safeDiv(ONE_BD, bundle.ethPriceUSD)
  }

  const whiteList = token.whitelistPools
  let largestFreshETH = ZERO_BD
  let freshPrice = ZERO_BD
  let largestETH = ZERO_BD
  let anyPrice = ZERO_BD
  for (let i = 0; i < whiteList.length; ++i) {
    const pool = Pool.load(whiteList[i])
    if (pool === null || pool.liquidity.le(ZERO_BI)) {
      continue
    }
    // the whitelisted leg: its ETH value, and the ETH price it implies for our token
    let ethLocked = ZERO_BD
    let price = ZERO_BD
    if (pool.token0 == token.id) {
      const token1 = Token.load(pool.token1)
      if (token1 === null) {
        continue
      }
      ethLocked = pool.totalValueLockedToken1.times(token1.derivedETH)
      // token1 per our token * ETH per token1
      price = pool.token1Price.times(token1.derivedETH)
    } else if (pool.token1 == token.id) {
      const token0 = Token.load(pool.token0)
      if (token0 === null) {
        continue
      }
      ethLocked = pool.totalValueLockedToken0.times(token0.derivedETH)
      // token0 per our token * ETH per token0
      price = pool.token0Price.times(token0.derivedETH)
    } else {
      continue
    }
    const legUSDTwice = ethLocked.times(bundle.ethPriceUSD).times(TWO_BD)
    if (legUSDTwice.le(minimumUSDLocked)) {
      continue
    }
    if (ethLocked.gt(largestETH)) {
      largestETH = ethLocked
      anyPrice = price
    }
    const lastSwap = pool.lastSwapTimestamp
    if (lastSwap !== null && timestamp.minus(lastSwap as BigInt).le(PRICING_POOL_FRESH_SECONDS)) {
      if (ethLocked.gt(largestFreshETH)) {
        largestFreshETH = ethLocked
        freshPrice = price
      }
    }
  }
  return largestFreshETH.gt(ZERO_BD) ? freshPrice : anyPrice
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
export function getTrackedAmountUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token,
  whitelistTokens: string[],
): BigDecimal {
  const bundle = Bundle.load('1')!
  const price0USD = token0.derivedETH.times(bundle.ethPriceUSD)
  const price1USD = token1.derivedETH.times(bundle.ethPriceUSD)

  // both are whitelist tokens, return sum of both amounts
  if (whitelistTokens.includes(token0.id) && whitelistTokens.includes(token1.id)) {
    return tokenAmount0.times(price0USD).plus(tokenAmount1.times(price1USD))
  }

  // take double value of the whitelisted token amount
  if (whitelistTokens.includes(token0.id) && !whitelistTokens.includes(token1.id)) {
    return tokenAmount0.times(price0USD).times(BigDecimal.fromString('2'))
  }

  // take double value of the whitelisted token amount
  if (!whitelistTokens.includes(token0.id) && whitelistTokens.includes(token1.id)) {
    return tokenAmount1.times(price1USD).times(BigDecimal.fromString('2'))
  }

  // neither token is on white list, tracked amount is 0
  return ZERO_BD
}

export function calculateAmountUSD(
  amount0: BigDecimal,
  amount1: BigDecimal,
  token0DerivedETH: BigDecimal,
  token1DerivedETH: BigDecimal,
  ethPriceUSD: BigDecimal,
): BigDecimal {
  return amount0.times(token0DerivedETH.times(ethPriceUSD)).plus(amount1.times(token1DerivedETH.times(ethPriceUSD)))
}
