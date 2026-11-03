import { ethereum } from '@graphprotocol/graph-ts'

import { Bundle, ModifyLiquidity, Position, PositionSnapshot, Token } from '../types/schema'
import { ONE_BI, ZERO_BD, ZERO_BI } from './constants'

// A Position is created at its NFT Transfer, one log before the ModifyLiquidity
// that fills it: start every accumulator at zero so the row is complete meanwhile.
export function initPositionState(position: Position): void {
  position.liquidity = ZERO_BI
  position.modifyCount = ZERO_BI
  position.depositedToken0 = ZERO_BD
  position.depositedToken1 = ZERO_BD
  position.withdrawnToken0 = ZERO_BD
  position.withdrawnToken1 = ZERO_BD
  position.depositedUSD = ZERO_BD
  position.withdrawnUSD = ZERO_BD
  position.depositedETH = ZERO_BD
  position.withdrawnETH = ZERO_BD
}

// Folds one PositionManager-routed ModifyLiquidity into its Position and writes the
// PositionSnapshot for it (README "Positions"). `modifyLiquidity` must already carry
// its amounts, sqrtPrice and tick. Principal only: v4 emits no fee amounts, so the
// fees this modify paid out are in none of these figures.
export function applyModifyLiquidityToPosition(
  position: Position,
  modifyLiquidity: ModifyLiquidity,
  event: ethereum.Event,
  token0: Token,
  token1: Token,
  bundle: Bundle,
): void {
  const delta = modifyLiquidity.amount
  const amount0 = modifyLiquidity.amount0
  const amount1 = modifyLiquidity.amount1
  const amountUSD = modifyLiquidity.amountUSD
  const amountETH = amount0.times(token0.derivedETH).plus(amount1.times(token1.derivedETH))

  // the first event is the mint: pool, range and entry price are fixed from here on
  if (position.pool === null) {
    position.pool = modifyLiquidity.pool
    position.tickLower = modifyLiquidity.tickLower
    position.tickUpper = modifyLiquidity.tickUpper
    position.mintSqrtPrice = modifyLiquidity.sqrtPrice
    position.mintTick = modifyLiquidity.tick
  }

  if (delta.gt(ZERO_BI)) {
    position.depositedToken0 = position.depositedToken0.plus(amount0)
    position.depositedToken1 = position.depositedToken1.plus(amount1)
    position.depositedUSD = position.depositedUSD.plus(amountUSD)
    position.depositedETH = position.depositedETH.plus(amountETH)
  } else if (delta.lt(ZERO_BI)) {
    // removal amounts are negative, like the delta; the accumulators hold magnitudes
    position.withdrawnToken0 = position.withdrawnToken0.plus(amount0.neg())
    position.withdrawnToken1 = position.withdrawnToken1.plus(amount1.neg())
    position.withdrawnUSD = position.withdrawnUSD.plus(amountUSD.neg())
    position.withdrawnETH = position.withdrawnETH.plus(amountETH.neg())
  }

  position.liquidity = position.liquidity.plus(delta)
  position.modifyCount = position.modifyCount.plus(ONE_BI)
  position.lastModifiedTimestamp = modifyLiquidity.timestamp
  if (position.liquidity.gt(ZERO_BI)) {
    position.closedAtTimestamp = null
  } else if (delta.lt(ZERO_BI)) {
    position.closedAtTimestamp = modifyLiquidity.timestamp
  }

  const snapshot = new PositionSnapshot(position.id + '#' + position.modifyCount.toString())
  snapshot.position = position.id
  snapshot.pool = modifyLiquidity.pool
  snapshot.owner = position.owner
  snapshot.transaction = modifyLiquidity.transaction
  snapshot.modifyLiquidity = modifyLiquidity.id
  snapshot.timestamp = modifyLiquidity.timestamp
  snapshot.blockNumber = event.block.number
  snapshot.logIndex = event.logIndex
  snapshot.liquidityDelta = delta
  snapshot.liquidity = position.liquidity
  snapshot.amount0 = amount0
  snapshot.amount1 = amount1
  snapshot.amountUSD = amountUSD
  snapshot.amountETH = amountETH
  snapshot.depositedToken0 = position.depositedToken0
  snapshot.depositedToken1 = position.depositedToken1
  snapshot.withdrawnToken0 = position.withdrawnToken0
  snapshot.withdrawnToken1 = position.withdrawnToken1
  snapshot.depositedUSD = position.depositedUSD
  snapshot.withdrawnUSD = position.withdrawnUSD
  snapshot.depositedETH = position.depositedETH
  snapshot.withdrawnETH = position.withdrawnETH
  snapshot.sqrtPrice = modifyLiquidity.sqrtPrice
  snapshot.tick = modifyLiquidity.tick
  snapshot.ethPriceUSD = bundle.ethPriceUSD
  snapshot.token0DerivedETH = token0.derivedETH
  snapshot.token1DerivedETH = token1.derivedETH

  position.save()
  snapshot.save()
}
