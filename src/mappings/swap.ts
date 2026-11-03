import { Address, BigDecimal, BigInt, log } from '@graphprotocol/graph-ts'

import { AggregatorHook } from '../types/PoolManager/AggregatorHook'
import { Swap as SwapEvent } from '../types/PoolManager/PoolManager'
import { Bundle, Pool, PoolManager, Swap, SwapStaging, Token } from '../types/schema'
import { getSubgraphConfig, getUSDStableStableHookAddresses, SubgraphConfig } from '../utils/chains'
import { ONE_BD, ONE_BI, ZERO_BD, ZERO_BI } from '../utils/constants'
import { lpFeeFromSwapFee } from '../utils/fees'
import { convertTokenToDecimal, loadTransaction, safeDiv } from '../utils/index'
import {
  updatePoolDayData,
  updatePoolHourData,
  updateTokenDayData,
  updateTokenHourData,
} from '../utils/intervalUpdates'
import {
  findNativePerToken,
  getNativePriceInUSD,
  getTrackedAmountUSD,
  sqrtPriceX96ToTokenPrices,
} from '../utils/pricing'

const PIPS_BD = BigDecimal.fromString('1000000')

// `pips` millionths of `amount`
function pipsOf(amount: BigDecimal, pips: BigInt): BigDecimal {
  return amount.times(pips.toBigDecimal()).div(PIPS_BD)
}

export function handleSwap(event: SwapEvent): void {
  handleSwapHelper(event)
}

export function handleSwapHelper(event: SwapEvent, subgraphConfig: SubgraphConfig = getSubgraphConfig()): void {
  const poolManagerAddress = subgraphConfig.poolManagerAddress
  const stablecoinWrappedNativePoolId = subgraphConfig.stablecoinWrappedNativePoolId
  const stablecoinIsToken0 = subgraphConfig.stablecoinIsToken0
  const wrappedNativeAddress = subgraphConfig.wrappedNativeAddress
  const stablecoinAddresses = subgraphConfig.stablecoinAddresses
  const minimumUSDLocked = subgraphConfig.minimumUSDLocked
  const whitelistTokens = subgraphConfig.whitelistTokens
  const nativeTokenDetails = subgraphConfig.nativeTokenDetails
  const usdStableStableHookAddresses = getUSDStableStableHookAddresses()

  const bundle = Bundle.load('1')!
  const poolManager = PoolManager.load(poolManagerAddress)!
  const poolId = event.params.id.toHexString()
  const pool = Pool.load(poolId)

  if (!pool) {
    log.warning('Pool not found: {}', [poolId])
    return
  }

  const token0 = Token.load(pool.token0)
  const token1 = Token.load(pool.token1)

  if (token0 && token1) {
    // Entering (pre-swap) prices, captured before this swap mutates pool price,
    // bundle.ethPriceUSD, or derivedETH. The pool sits at these until the swap
    // executes, so they are the `open` when this swap starts a new candle bucket.
    const token0PriceBefore = pool.token0Price
    const token0PriceUSDBefore = token0.derivedETH.times(bundle.ethPriceUSD)
    const token1PriceUSDBefore = token1.derivedETH.times(bundle.ethPriceUSD)

    // amounts - 0/1 are token deltas: can be positive or negative
    // Unlike V3, a negative amount represents that amount is being sent to the pool and vice versa, so invert the sign
    const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals).times(BigDecimal.fromString('-1'))
    const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals).times(BigDecimal.fromString('-1'))

    // --- fee rates of this swap (README "Pool fee and TVL semantics") ---
    // Swap.fee is the rate the swapper paid the pool on its gross input: the LP
    // fee with Uniswap's protocol fee folded in (v4-core
    // ProtocolFeeLibrary.calculateSwapFee). Uniswap's rate depends on the swap
    // direction and is charged on the input token.
    const swapFee = BigInt.fromI32(event.params.fee as i32)
    const zeroForOne = event.params.amount0.lt(ZERO_BI)
    const uniswapProtocolFee = zeroForOne ? pool.uniswapProtocolFeeZeroForOne : pool.uniswapProtocolFeeOneForZero
    // Pool.swap takes Uniswap's cut of the gross input and credits LPs the rest of
    // the fee, so the LP take is exactly swapFee - uniswapProtocolFee pips of input.
    let lpTakePips = swapFee.minus(uniswapProtocolFee)
    if (lpTakePips.lt(ZERO_BI)) {
      lpTakePips = ZERO_BI
    }
    // The nominal LP rate: a static pool's tier, or on a dynamic-fee pool the
    // hook's override recovered from the protocol-inclusive Swap.fee.
    let lpFee = pool.isDynamicFee ? lpFeeFromSwapFee(swapFee, uniswapProtocolFee) : pool.feeTier
    // An Ascnt hook staged its dynamic fee in BeforeSwap, earlier in this tx. That
    // is the rate the pool charged before Uniswap's cut: the hook lowered its LP
    // override to lpFee and takes the difference in afterSwap as a hook delta on
    // the unspecified currency, so Ascnt's cut is never inside Swap.fee.
    const transaction = loadTransaction(event)
    const swapStagingId = transaction.id + '-' + poolId
    const swapStaging = SwapStaging.load(swapStagingId)
    let poolFee = lpFee
    if (swapStaging !== null) {
      const stagedDynamicFee = swapStaging.dynamicFeePips
      if (stagedDynamicFee !== null) {
        poolFee = stagedDynamicFee as BigInt
        // The override can never exceed the hook's fee. lpFeeFromSwapFee picks the
        // larger of two candidates when the floor makes them collide, so trim a
        // one-pip overshoot instead of reporting a negative cut.
        if (lpFee.gt(poolFee)) {
          lpFee = poolFee
        }
      }
    }
    const ascntProtocolFee = poolFee.minus(lpFee)
    const totalSwapFee = poolFee.plus(uniswapProtocolFee)

    // feeTier is the pool key's fee and never changes; the last swap's rates sit
    // beside it.
    pool.poolFee = poolFee
    pool.lpFee = lpFee
    pool.ascntProtocolFee = ascntProtocolFee
    pool.totalSwapFee = totalSwapFee

    // need absolute amounts for volume
    let amount0Abs = amount0
    if (amount0.lt(ZERO_BD)) {
      amount0Abs = amount0.times(BigDecimal.fromString('-1'))
    }
    let amount1Abs = amount1
    if (amount1.lt(ZERO_BD)) {
      amount1Abs = amount1.times(BigDecimal.fromString('-1'))
    }

    const amount0ETH = amount0Abs.times(token0.derivedETH)
    const amount1ETH = amount1Abs.times(token1.derivedETH)
    const amount0USD = amount0ETH.times(bundle.ethPriceUSD)
    const amount1USD = amount1ETH.times(bundle.ethPriceUSD)

    const isUSDStableStableHookPool = usdStableStableHookAddresses.includes(pool.hooks.toLowerCase())

    let amountTotalUSDTracked: BigDecimal
    let amountTotalETHTracked: BigDecimal
    let amountTotalUSDUntracked: BigDecimal
    if (isUSDStableStableHookPool) {
      amountTotalUSDTracked = amount0Abs.plus(amount1Abs).div(BigDecimal.fromString('2'))
      amountTotalETHTracked = safeDiv(amountTotalUSDTracked, bundle.ethPriceUSD)
      amountTotalUSDUntracked = amountTotalUSDTracked
    } else {
      // get amount that should be tracked only - div 2 because cant count both input and output as volume
      amountTotalUSDTracked = getTrackedAmountUSD(amount0Abs, token0, amount1Abs, token1, whitelistTokens).div(
        BigDecimal.fromString('2'),
      )
      amountTotalETHTracked = safeDiv(amountTotalUSDTracked, bundle.ethPriceUSD)
      amountTotalUSDUntracked = amount0USD.plus(amount1USD).div(BigDecimal.fromString('2'))
    }

    // --- fee amounts, split by who receives them ---
    // LP fees are the exact LP take; Uniswap's cut is its rate on the same base.
    // Both are charged on the gross input, the positive delta here. Ascnt's cut
    // is accumulated by the hook's ProtocolFeeTaken handler, not here.
    const lpFeesETH = pipsOf(amountTotalETHTracked, lpTakePips)
    const lpFeesUSD = pipsOf(amountTotalUSDTracked, lpTakePips)
    const uniswapProtocolFeesUSD = pipsOf(amountTotalUSDTracked, uniswapProtocolFee)
    const grossInput0 = amount0.gt(ZERO_BD) ? amount0 : ZERO_BD
    const grossInput1 = amount1.gt(ZERO_BD) ? amount1 : ZERO_BD
    const lpFeesToken0 = pipsOf(grossInput0, lpTakePips)
    const lpFeesToken1 = pipsOf(grossInput1, lpTakePips)
    const uniswapProtocolFeesToken0 = pipsOf(grossInput0, uniswapProtocolFee)
    const uniswapProtocolFeesToken1 = pipsOf(grossInput1, uniswapProtocolFee)

    // TVL is the pool's liquidity-backed reserves, and the fee taken from the input
    // never joins them: the LP share accrues to feeGrowth and is paid out on the
    // position's next ModifyLiquidity (any liquidityDelta; v4 has no Collect event
    // and ModifyLiquidity carries no fee amounts), the protocol share sits in
    // protocolFeesAccrued until collectProtocolFees. Adding the gross input made
    // TVL drift up by every fee ever charged. Add the input net of the whole swap
    // fee; the output side (negative) leaves in full.
    const feeFraction = swapFee.toBigDecimal().div(PIPS_BD)
    const reserveDelta0 = amount0.gt(ZERO_BD) ? amount0.times(ONE_BD.minus(feeFraction)) : amount0
    const reserveDelta1 = amount1.gt(ZERO_BD) ? amount1.times(ONE_BD.minus(feeFraction)) : amount1

    // global updates
    poolManager.txCount = poolManager.txCount.plus(ONE_BI)
    poolManager.totalVolumeETH = poolManager.totalVolumeETH.plus(amountTotalETHTracked)
    poolManager.totalVolumeUSD = poolManager.totalVolumeUSD.plus(amountTotalUSDTracked)
    poolManager.untrackedVolumeUSD = poolManager.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
    poolManager.totalLpFeesETH = poolManager.totalLpFeesETH.plus(lpFeesETH)
    poolManager.totalLpFeesUSD = poolManager.totalLpFeesUSD.plus(lpFeesUSD)

    // reset aggregate tvl before individual pool tvl updates
    const currentPoolTvlETH = pool.totalValueLockedETH
    poolManager.totalValueLockedETH = poolManager.totalValueLockedETH.minus(currentPoolTvlETH)

    // pool volume and fees
    pool.volumeToken0 = pool.volumeToken0.plus(amount0Abs)
    pool.volumeToken1 = pool.volumeToken1.plus(amount1Abs)
    pool.volumeUSD = pool.volumeUSD.plus(amountTotalUSDTracked)
    pool.untrackedVolumeUSD = pool.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
    pool.lpFeesUSD = pool.lpFeesUSD.plus(lpFeesUSD)
    pool.lpFeesToken0 = pool.lpFeesToken0.plus(lpFeesToken0)
    pool.lpFeesToken1 = pool.lpFeesToken1.plus(lpFeesToken1)
    pool.uniswapProtocolFeesUSD = pool.uniswapProtocolFeesUSD.plus(uniswapProtocolFeesUSD)
    pool.uniswapProtocolFeesToken0 = pool.uniswapProtocolFeesToken0.plus(uniswapProtocolFeesToken0)
    pool.uniswapProtocolFeesToken1 = pool.uniswapProtocolFeesToken1.plus(uniswapProtocolFeesToken1)
    pool.txCount = pool.txCount.plus(ONE_BI)

    // Update the pool with the new active liquidity, price, and tick.
    pool.liquidity = event.params.liquidity
    pool.sqrtPrice = event.params.sqrtPriceX96
    pool.tick = BigInt.fromI32(event.params.tick as i32)
    if (!isUSDStableStableHookPool) {
      pool.totalValueLockedToken0 = pool.totalValueLockedToken0.plus(reserveDelta0)
      pool.totalValueLockedToken1 = pool.totalValueLockedToken1.plus(reserveDelta1)
    }

    // update token0 data
    token0.volume = token0.volume.plus(amount0Abs)
    token0.totalValueLocked = token0.totalValueLocked.plus(reserveDelta0)
    token0.volumeUSD = token0.volumeUSD.plus(amountTotalUSDTracked)
    token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
    token0.lpFeesUSD = token0.lpFeesUSD.plus(lpFeesUSD)
    token0.txCount = token0.txCount.plus(ONE_BI)

    // update token1 data
    token1.volume = token1.volume.plus(amount1Abs)
    token1.totalValueLocked = token1.totalValueLocked.plus(reserveDelta1)
    token1.volumeUSD = token1.volumeUSD.plus(amountTotalUSDTracked)
    token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
    token1.lpFeesUSD = token1.lpFeesUSD.plus(lpFeesUSD)
    token1.txCount = token1.txCount.plus(ONE_BI)

    // updated pool rates
    if (!isUSDStableStableHookPool) {
      const prices = sqrtPriceX96ToTokenPrices(pool.sqrtPrice, token0, token1, nativeTokenDetails)
      pool.token0Price = prices[0]
      pool.token1Price = prices[1]
    }
    pool.lastSwapTimestamp = event.block.timestamp

    // Save before pricing. getNativePriceInUSD and findNativePerToken load pools
    // from the store, and when this pool is the ETH/USD pool or a token's pricing
    // pool they must see its post-swap price, reserves and lastSwapTimestamp, not
    // the previous swap's (upstream reads them one swap late).
    pool.save()

    if (!isUSDStableStableHookPool) {
      bundle.ethPriceUSD = getNativePriceInUSD(stablecoinWrappedNativePoolId, stablecoinIsToken0)
    }
    bundle.save()
    const now = event.block.timestamp
    token0.derivedETH = findNativePerToken(token0, wrappedNativeAddress, stablecoinAddresses, minimumUSDLocked, now)
    token1.derivedETH = findNativePerToken(token1, wrappedNativeAddress, stablecoinAddresses, minimumUSDLocked, now)

    /**
     * Things afffected by new USD rates
     */
    if (!isUSDStableStableHookPool) {
      pool.totalValueLockedETH = pool.totalValueLockedToken0
        .times(token0.derivedETH)
        .plus(pool.totalValueLockedToken1.times(token1.derivedETH))
      pool.totalValueLockedUSD = pool.totalValueLockedETH.times(bundle.ethPriceUSD)
    }

    // For Tempo stable-stable hook pools, source TVL from the hook contract.
    if (isUSDStableStableHookPool) {
      const hookContract = AggregatorHook.bind(Address.fromString(pool.hooks))
      const tvlResult = hookContract.try_pseudoTotalValueLocked(event.params.id)
      if (!tvlResult.reverted) {
        const tvl0Token = convertTokenToDecimal(tvlResult.value.value0, token0.decimals)
        const tvl1Token = convertTokenToDecimal(tvlResult.value.value1, token1.decimals)
        const hookPoolTVLUSD = tvl0Token.plus(tvl1Token)
        const hookPoolTVLETH = safeDiv(hookPoolTVLUSD, bundle.ethPriceUSD)
        pool.totalValueLockedToken0 = tvl0Token
        pool.totalValueLockedToken1 = tvl1Token
        pool.totalValueLockedUSD = hookPoolTVLUSD
        pool.totalValueLockedETH = hookPoolTVLETH
      }
    }

    poolManager.totalValueLockedETH = poolManager.totalValueLockedETH.plus(pool.totalValueLockedETH)
    poolManager.totalValueLockedUSD = poolManager.totalValueLockedETH.times(bundle.ethPriceUSD)

    token0.totalValueLockedUSD = token0.totalValueLocked.times(token0.derivedETH).times(bundle.ethPriceUSD)
    token1.totalValueLockedUSD = token1.totalValueLocked.times(token1.derivedETH).times(bundle.ethPriceUSD)

    // create Swap event
    const swapId = transaction.id + '-' + event.logIndex.toString()
    const swap = new Swap(swapId)
    swap.transaction = transaction.id
    swap.timestamp = transaction.timestamp
    swap.pool = pool.id
    swap.token0 = pool.token0
    swap.token1 = pool.token1
    swap.sender = event.params.sender
    swap.origin = event.transaction.from
    swap.amount0 = amount0
    swap.amount1 = amount1
    swap.amountUSD = amountTotalUSDTracked
    swap.tick = BigInt.fromI32(event.params.tick as i32)
    swap.sqrtPriceX96 = event.params.sqrtPriceX96
    swap.logIndex = event.logIndex
    swap.poolFee = poolFee
    swap.lpFee = lpFee
    swap.ascntProtocolFee = ascntProtocolFee
    swap.uniswapProtocolFee = uniswapProtocolFee
    swap.totalSwapFee = totalSwapFee

    if (swapStaging) {
      swap.sqrtPriceX96Before = swapStaging.sqrtPriceX96Before
      swap.illiqBefore = swapStaging.illiqBefore
      swap.estimatedVolume1 = swapStaging.estimatedVolume1
      swap.estimatedPriceImpact = swapStaging.estimatedPriceImpact
      swap.decayedCumPriceImpact = swapStaging.decayedCumPriceImpact
      swap.dynamicFeePips = swapStaging.dynamicFeePips
      swapStaging.swapId = swap.id
      swapStaging.save()
    }

    // interval data — pass the in-memory pool (post-swap price/tick/tvl already
    // applied) so candles reflect THIS swap, not the last-saved (previous) one.
    const poolDayData = updatePoolDayData(pool, event, token0PriceBefore)
    const poolHourData = updatePoolHourData(pool, event, token0PriceBefore)

    poolDayData.swapCount = poolDayData.swapCount.plus(ONE_BI)
    poolHourData.swapCount = poolHourData.swapCount.plus(ONE_BI)

    const token0DayData = updateTokenDayData(token0, event, token0PriceUSDBefore)
    const token1DayData = updateTokenDayData(token1, event, token1PriceUSDBefore)
    const token0HourData = updateTokenHourData(token0, event, token0PriceUSDBefore)
    const token1HourData = updateTokenHourData(token1, event, token1PriceUSDBefore)

    poolDayData.volumeUSD = poolDayData.volumeUSD.plus(amountTotalUSDTracked)
    poolDayData.volumeToken0 = poolDayData.volumeToken0.plus(amount0Abs)
    poolDayData.volumeToken1 = poolDayData.volumeToken1.plus(amount1Abs)
    poolDayData.lpFeesUSD = poolDayData.lpFeesUSD.plus(lpFeesUSD)
    poolDayData.uniswapProtocolFeesUSD = poolDayData.uniswapProtocolFeesUSD.plus(uniswapProtocolFeesUSD)

    poolHourData.volumeUSD = poolHourData.volumeUSD.plus(amountTotalUSDTracked)
    poolHourData.volumeToken0 = poolHourData.volumeToken0.plus(amount0Abs)
    poolHourData.volumeToken1 = poolHourData.volumeToken1.plus(amount1Abs)
    poolHourData.lpFeesUSD = poolHourData.lpFeesUSD.plus(lpFeesUSD)
    poolHourData.uniswapProtocolFeesUSD = poolHourData.uniswapProtocolFeesUSD.plus(uniswapProtocolFeesUSD)

    // the untracked buckets take the untracked amount (upstream adds the tracked one)
    token0DayData.volume = token0DayData.volume.plus(amount0Abs)
    token0DayData.volumeUSD = token0DayData.volumeUSD.plus(amountTotalUSDTracked)
    token0DayData.untrackedVolumeUSD = token0DayData.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
    token0DayData.lpFeesUSD = token0DayData.lpFeesUSD.plus(lpFeesUSD)

    token0HourData.volume = token0HourData.volume.plus(amount0Abs)
    token0HourData.volumeUSD = token0HourData.volumeUSD.plus(amountTotalUSDTracked)
    token0HourData.untrackedVolumeUSD = token0HourData.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
    token0HourData.lpFeesUSD = token0HourData.lpFeesUSD.plus(lpFeesUSD)

    token1DayData.volume = token1DayData.volume.plus(amount1Abs)
    token1DayData.volumeUSD = token1DayData.volumeUSD.plus(amountTotalUSDTracked)
    token1DayData.untrackedVolumeUSD = token1DayData.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
    token1DayData.lpFeesUSD = token1DayData.lpFeesUSD.plus(lpFeesUSD)

    token1HourData.volume = token1HourData.volume.plus(amount1Abs)
    token1HourData.volumeUSD = token1HourData.volumeUSD.plus(amountTotalUSDTracked)
    token1HourData.untrackedVolumeUSD = token1HourData.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
    token1HourData.lpFeesUSD = token1HourData.lpFeesUSD.plus(lpFeesUSD)

    swap.save()
    token0DayData.save()
    token1DayData.save()
    poolDayData.save()
    poolHourData.save()
    token0HourData.save()
    token1HourData.save()
    poolManager.save()
    pool.save()
    token0.save()
    token1.save()
  }
}
