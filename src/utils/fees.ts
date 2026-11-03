import { BigInt } from '@graphprotocol/graph-ts'

import { ZERO_BI } from './constants'

// Fee rates here are pips (hundredths of a bip, 1_000_000 = 100%), as in v4-core.
export const PIPS_DENOMINATOR = BigInt.fromI32(1000000)

// v4-core ProtocolFeeLibrary: a pool's protocol fee is one packed uint24, the
// zeroForOne rate in the low 12 bits and the oneForZero rate in the high 12 bits
// (each at most 1000 pips = 0.1%).
export function protocolFeeZeroForOne(packed: i32): BigInt {
  return BigInt.fromI32(packed & 0xfff)
}

export function protocolFeeOneForZero(packed: i32): BigInt {
  return BigInt.fromI32((packed >> 12) & 0xfff)
}

// Swap.fee is the rate the swapper paid on its gross input, with the protocol
// share folded in (ProtocolFeeLibrary.calculateSwapFee):
//   swapFee = protocolFee + lpFee - floor(protocolFee * lpFee / 1e6)
// This inverts it to recover the LP fee the pool (or its hook) set. The floor
// makes the map non-injective: at most two neighbouring lpFee values share one
// swapFee, and this returns the larger. With protocolFee 0, swapFee == lpFee.
export function lpFeeFromSwapFee(swapFee: BigInt, protocolFee: BigInt): BigInt {
  const lpShare = swapFee.minus(protocolFee)
  if (lpShare.le(ZERO_BI)) {
    return ZERO_BI
  }
  if (protocolFee.isZero()) {
    return swapFee
  }
  return lpShare.times(PIPS_DENOMINATOR).div(PIPS_DENOMINATOR.minus(protocolFee))
}
