import { BigInt } from '@graphprotocol/graph-ts'
import { assert, describe, test } from 'matchstick-as/assembly/index'

import { lpFeeFromSwapFee, protocolFeeOneForZero, protocolFeeZeroForOne } from '../../src/utils/fees'

function bi(n: i32): BigInt {
  return BigInt.fromI32(n)
}

describe('protocol fee unpacking', () => {
  test('splits the packed uint24 into its two 12-bit rates', () => {
    assert.bigIntEquals(protocolFeeZeroForOne(2044403), bi(499))
    assert.bigIntEquals(protocolFeeOneForZero(2044403), bi(499))
    assert.bigIntEquals(protocolFeeZeroForOne(819300), bi(100))
    assert.bigIntEquals(protocolFeeOneForZero(819300), bi(200))
    assert.bigIntEquals(protocolFeeZeroForOne(0), bi(0))
    assert.bigIntEquals(protocolFeeOneForZero(0), bi(0))
  })
})

describe('lpFeeFromSwapFee', () => {
  // The mainnet cases from the bug report: Swap.fee, protocol fee -> LP tier
  test('recovers the LP tier from the protocol-inclusive Swap.fee', () => {
    assert.bigIntEquals(lpFeeFromSwapFee(bi(3497), bi(499)), bi(2999)) // ETH/MORPHO 0.2999%
    assert.bigIntEquals(lpFeeFromSwapFee(bi(625), bi(125)), bi(500)) // ETH/USDC 0.05%
    assert.bigIntEquals(lpFeeFromSwapFee(bi(9), bi(2)), bi(7)) // USDC/USDT
    assert.bigIntEquals(lpFeeFromSwapFee(bi(3000), bi(0)), bi(3000)) // protocol fee off
  })

  test('round-trips calculateSwapFee for every fee up to 1% at the max protocol fee', () => {
    const protocolFee = bi(1000)
    for (let lpFee = 0; lpFee <= 10000; lpFee++) {
      // calculateSwapFee: protocolFee + lpFee - floor(protocolFee * lpFee / 1e6)
      const swapFee = protocolFee.plus(bi(lpFee)).minus(protocolFee.times(bi(lpFee)).div(bi(1000000)))
      const recovered = lpFeeFromSwapFee(swapFee, protocolFee)
      // The floor collapses neighbouring tiers onto one swapFee; the larger is
      // returned, so the result is lpFee or lpFee + 1 and always maps back.
      const roundTrip = protocolFee.plus(recovered).minus(protocolFee.times(recovered).div(bi(1000000)))
      assert.bigIntEquals(roundTrip, swapFee)
      assert.assertTrue(recovered.ge(bi(lpFee)) && recovered.le(bi(lpFee + 1)))
    }
  })

  test('clamps a swap fee below the protocol fee to zero', () => {
    assert.bigIntEquals(lpFeeFromSwapFee(bi(100), bi(499)), bi(0))
    assert.bigIntEquals(lpFeeFromSwapFee(bi(0), bi(0)), bi(0))
  })
})
