import { Address, BigDecimal, BigInt, Bytes, ethereum } from '@graphprotocol/graph-ts'
import { assert, beforeAll, clearStore, describe, newMockEvent, test } from 'matchstick-as'

import { ascntBeforeSwapCore } from '../../src/mappings/ascntCore'
import { handleProtocolFeeUpdated } from '../../src/mappings/protocolFee'
import { handleSwapHelper } from '../../src/mappings/swap'
import { ProtocolFeeUpdated, Swap } from '../../src/types/PoolManager/PoolManager'
import { Bundle, Pool, PoolHourData, Token } from '../../src/types/schema'
import { ONE_BD, ZERO_BD } from '../../src/utils/constants'
import { convertTokenToDecimal, safeDiv } from '../../src/utils/index'
import {
  findNativePerToken,
  getNativePriceInUSD,
  getTrackedAmountUSD,
  sqrtPriceX96ToTokenPrices,
} from '../../src/utils/pricing'
import {
  assertObjectMatches,
  invokePoolCreatedWithMockedEthCalls,
  MOCK_EVENT,
  POOL_FEE_TIER_05,
  TEST_CONFIG,
  TEST_ETH_PRICE_USD,
  TEST_USDC_DERIVED_ETH,
  TEST_WETH_DERIVED_ETH,
  USDC_MAINNET_FIXTURE,
  USDC_WETH_05_MAINNET_POOL_FIXTURE,
  USDC_WETH_POOL_ID,
  WETH_MAINNET_FIXTURE,
} from './constants'

class SwapFixture {
  id: string
  sender: Address
  amount0: BigInt
  amount1: BigInt
  sqrtPriceX96: BigInt
  liquidity: BigInt
  tick: i32
  fee: i32
}

// https://sepolia.etherscan.io/tx/0x55e13046016b653bd125e26917fac1b06dd15bf7b0659701d5e9d00b7b403f2c#eventlog
const SWAP_FIXTURE: SwapFixture = {
  id: USDC_WETH_POOL_ID,
  sender: Address.fromString('0x841B5A0b3DBc473c8A057E2391014aa4C4751351'),
  amount0: BigInt.fromString('-10007'),
  amount1: BigInt.fromString('10000'),
  sqrtPriceX96: BigInt.fromString('79228162514264337514315787821'),
  liquidity: BigInt.fromString('10000000000000000000000'),
  tick: -1,
  fee: 500,
}

const SWAP_EVENT = new Swap(
  MOCK_EVENT.address,
  MOCK_EVENT.logIndex,
  MOCK_EVENT.transactionLogIndex,
  MOCK_EVENT.logType,
  MOCK_EVENT.block,
  MOCK_EVENT.transaction,
  [
    new ethereum.EventParam('id', ethereum.Value.fromFixedBytes(Bytes.fromHexString(SWAP_FIXTURE.id))),
    new ethereum.EventParam('sender', ethereum.Value.fromAddress(SWAP_FIXTURE.sender)),
    new ethereum.EventParam('amount0', ethereum.Value.fromSignedBigInt(SWAP_FIXTURE.amount0)),
    new ethereum.EventParam('amount1', ethereum.Value.fromSignedBigInt(SWAP_FIXTURE.amount1)),
    new ethereum.EventParam('sqrtPriceX96', ethereum.Value.fromSignedBigInt(SWAP_FIXTURE.sqrtPriceX96)),
    new ethereum.EventParam('liquidity', ethereum.Value.fromSignedBigInt(SWAP_FIXTURE.liquidity)),
    new ethereum.EventParam('tick', ethereum.Value.fromI32(SWAP_FIXTURE.tick)),
    new ethereum.EventParam('fee', ethereum.Value.fromI32(SWAP_FIXTURE.fee)),
  ],
  MOCK_EVENT.receipt,
)

// Build a Swap event like SWAP_EVENT but at a given timestamp and post-swap price.
function createSwapEvent(sqrtPriceX96: BigInt, timestamp: BigInt): Swap {
  return createSwapEventWith(sqrtPriceX96, timestamp, SWAP_FIXTURE.amount0, SWAP_FIXTURE.amount1, SWAP_FIXTURE.fee)
}

// Same, with the swapper's deltas and the Swap.fee (the protocol-inclusive rate) chosen.
function createSwapEventWith(
  sqrtPriceX96: BigInt,
  timestamp: BigInt,
  amount0: BigInt,
  amount1: BigInt,
  fee: i32,
): Swap {
  const e = newMockEvent()
  e.block.timestamp = timestamp
  return new Swap(
    MOCK_EVENT.address,
    MOCK_EVENT.logIndex,
    MOCK_EVENT.transactionLogIndex,
    MOCK_EVENT.logType,
    e.block,
    MOCK_EVENT.transaction,
    [
      new ethereum.EventParam('id', ethereum.Value.fromFixedBytes(Bytes.fromHexString(SWAP_FIXTURE.id))),
      new ethereum.EventParam('sender', ethereum.Value.fromAddress(SWAP_FIXTURE.sender)),
      new ethereum.EventParam('amount0', ethereum.Value.fromSignedBigInt(amount0)),
      new ethereum.EventParam('amount1', ethereum.Value.fromSignedBigInt(amount1)),
      new ethereum.EventParam('sqrtPriceX96', ethereum.Value.fromSignedBigInt(sqrtPriceX96)),
      new ethereum.EventParam('liquidity', ethereum.Value.fromSignedBigInt(SWAP_FIXTURE.liquidity)),
      new ethereum.EventParam('tick', ethereum.Value.fromI32(SWAP_FIXTURE.tick)),
      new ethereum.EventParam('fee', ethereum.Value.fromI32(fee)),
    ],
    MOCK_EVENT.receipt,
  )
}

// PoolManager.ProtocolFeeUpdated for the test pool with the packed uint24 rate
// (low 12 bits zeroForOne, high 12 bits oneForZero).
function createProtocolFeeUpdatedEvent(packedProtocolFee: i32): ProtocolFeeUpdated {
  return new ProtocolFeeUpdated(
    MOCK_EVENT.address,
    MOCK_EVENT.logIndex,
    MOCK_EVENT.transactionLogIndex,
    MOCK_EVENT.logType,
    MOCK_EVENT.block,
    MOCK_EVENT.transaction,
    [
      new ethereum.EventParam('id', ethereum.Value.fromFixedBytes(Bytes.fromHexString(SWAP_FIXTURE.id))),
      new ethereum.EventParam('protocolFee', ethereum.Value.fromI32(packedProtocolFee)),
    ],
    MOCK_EVENT.receipt,
  )
}

// Fresh pool + prices, as the first describe's beforeAll sets them up.
function setUpPoolWithPrices(): void {
  clearStore()
  invokePoolCreatedWithMockedEthCalls(MOCK_EVENT, TEST_CONFIG)

  const bundle = new Bundle('1')
  bundle.ethPriceUSD = TEST_ETH_PRICE_USD
  bundle.save()

  const usdcEntity = Token.load(USDC_MAINNET_FIXTURE.address)!
  usdcEntity.derivedETH = TEST_USDC_DERIVED_ETH
  usdcEntity.save()

  const wethEntity = Token.load(WETH_MAINNET_FIXTURE.address)!
  wethEntity.derivedETH = TEST_WETH_DERIVED_ETH
  wethEntity.save()
}

// Tracked USD volume of a swap, computed before the handler moves prices, and the
// LP fee on it at `lpFeePips` — mirrors swap.ts.
function trackedUSDBeforeSwap(amount0: BigInt, amount1: BigInt): BigDecimal {
  const token0 = Token.load(USDC_MAINNET_FIXTURE.address)!
  const token1 = Token.load(WETH_MAINNET_FIXTURE.address)!
  const amount0Abs = convertTokenToDecimal(amount0.abs(), BigInt.fromString(USDC_MAINNET_FIXTURE.decimals))
  const amount1Abs = convertTokenToDecimal(amount1.abs(), BigInt.fromString(WETH_MAINNET_FIXTURE.decimals))
  return getTrackedAmountUSD(amount0Abs, token0, amount1Abs, token1, TEST_CONFIG.whitelistTokens).div(
    BigDecimal.fromString('2'),
  )
}

function lpFeesUSD(trackedUSD: BigDecimal, lpFeePips: i32): BigDecimal {
  return trackedUSD.times(BigInt.fromI32(lpFeePips).toBigDecimal()).div(BigDecimal.fromString('1000000'))
}

// `pips` millionths of `amount` — mirrors swap.ts pipsOf.
function pipsOf(amount: BigDecimal, pips: i32): BigDecimal {
  return amount.times(BigInt.fromI32(pips).toBigDecimal()).div(BigDecimal.fromString('1000000'))
}

const SWAP_ENTITY_ID = MOCK_EVENT.transaction.hash.toHexString() + '-' + MOCK_EVENT.logIndex.toString()

// Reserve change for the input side: gross input net of the whole Swap.fee — mirrors swap.ts.
function netOfSwapFee(grossInput: BigDecimal, swapFee: i32): BigDecimal {
  const swapFeeBD = BigInt.fromI32(swapFee).toBigDecimal()
  const feeFraction = swapFeeBD.div(BigDecimal.fromString('1000000'))
  return grossInput.times(ONE_BD.minus(feeFraction))
}

describe('handleSwap', () => {
  beforeAll(() => {
    invokePoolCreatedWithMockedEthCalls(MOCK_EVENT, TEST_CONFIG)

    const bundle = new Bundle('1')
    bundle.ethPriceUSD = TEST_ETH_PRICE_USD
    bundle.save()

    const usdcEntity = Token.load(USDC_MAINNET_FIXTURE.address)!
    usdcEntity.derivedETH = TEST_USDC_DERIVED_ETH
    usdcEntity.save()

    const wethEntity = Token.load(WETH_MAINNET_FIXTURE.address)!
    wethEntity.derivedETH = TEST_WETH_DERIVED_ETH
    wethEntity.save()
  })

  test('success', () => {
    const token0 = Token.load(USDC_MAINNET_FIXTURE.address)!
    const token1 = Token.load(WETH_MAINNET_FIXTURE.address)!

    const amount0 = convertTokenToDecimal(SWAP_FIXTURE.amount0, BigInt.fromString(USDC_MAINNET_FIXTURE.decimals)).times(
      BigDecimal.fromString('-1'),
    )
    const amount1 = convertTokenToDecimal(SWAP_FIXTURE.amount1, BigInt.fromString(WETH_MAINNET_FIXTURE.decimals)).times(
      BigDecimal.fromString('-1'),
    )

    const amount0Abs = amount0.lt(ZERO_BD) ? amount0.times(BigDecimal.fromString('-1')) : amount0
    const amount1Abs = amount1.lt(ZERO_BD) ? amount1.times(BigDecimal.fromString('-1')) : amount1

    // calculate this before calling handleSwapHelper because it updates the derivedETH of the tokens which will affect calculations
    const amountTotalUSDTracked = getTrackedAmountUSD(
      amount0Abs,
      token0,
      amount1Abs,
      token1,
      TEST_CONFIG.whitelistTokens,
    ).div(BigDecimal.fromString('2'))

    const amount0ETH = amount0Abs.times(TEST_USDC_DERIVED_ETH)
    const amount1ETH = amount1Abs.times(TEST_WETH_DERIVED_ETH)

    const amount0USD = amount0ETH.times(TEST_ETH_PRICE_USD)
    const amount1USD = amount1ETH.times(TEST_ETH_PRICE_USD)

    const amountTotalETHTRacked = safeDiv(amountTotalUSDTracked, TEST_ETH_PRICE_USD)
    const amountTotalUSDUntracked = amount0USD.plus(amount1USD).div(BigDecimal.fromString('2'))

    // No ProtocolFeeUpdated yet, so Swap.fee is the LP tier and LPs get all of it.
    const feeTierBD = BigDecimal.fromString(POOL_FEE_TIER_05.toString())
    const feesETH = amountTotalETHTRacked.times(feeTierBD).div(BigDecimal.fromString('1000000'))
    const feesUSD = amountTotalUSDTracked.times(feeTierBD).div(BigDecimal.fromString('1000000'))

    // TVL takes the input (token0 here) net of the swap fee; the output leaves in full.
    const reserveDelta0 = amount0.gt(ZERO_BD) ? netOfSwapFee(amount0, SWAP_FIXTURE.fee) : amount0
    const reserveDelta1 = amount1.gt(ZERO_BD) ? netOfSwapFee(amount1, SWAP_FIXTURE.fee) : amount1

    handleSwapHelper(SWAP_EVENT, TEST_CONFIG)

    const newEthPrice = getNativePriceInUSD(USDC_WETH_POOL_ID, true)
    const newPoolPrices = sqrtPriceX96ToTokenPrices(
      SWAP_FIXTURE.sqrtPriceX96,
      token0,
      token1,
      TEST_CONFIG.nativeTokenDetails,
    )
    const newToken0DerivedETH = findNativePerToken(
      token0,
      TEST_CONFIG.wrappedNativeAddress,
      TEST_CONFIG.stablecoinAddresses,
      TEST_CONFIG.minimumUSDLocked,
      MOCK_EVENT.block.timestamp,
    )
    const newToken1DerivedETH = findNativePerToken(
      token1,
      TEST_CONFIG.wrappedNativeAddress,
      TEST_CONFIG.stablecoinAddresses,
      TEST_CONFIG.minimumUSDLocked,
      MOCK_EVENT.block.timestamp,
    )

    const totalValueLockedETH = reserveDelta0.times(newToken0DerivedETH).plus(reserveDelta1.times(newToken1DerivedETH))

    // OHLC: handleInitialize created the bucket at the init price (its open);
    // the swap must record ITS OWN post-swap price as the close (no one-swap lag).
    const initPoolPrices = sqrtPriceX96ToTokenPrices(
      BigInt.fromString(USDC_WETH_05_MAINNET_POOL_FIXTURE.sqrtPrice),
      token0,
      token1,
      TEST_CONFIG.nativeTokenDetails,
    )
    const poolOpen = initPoolPrices[0]
    const poolClose = newPoolPrices[0]
    const poolHigh = poolOpen.gt(poolClose) ? poolOpen : poolClose
    const poolLow = poolOpen.lt(poolClose) ? poolOpen : poolClose

    // Token buckets are created by this swap: open = entering (pre-swap) USD
    // price, close = post-swap USD price.
    const token0Open = TEST_USDC_DERIVED_ETH.times(TEST_ETH_PRICE_USD)
    const token0Close = newToken0DerivedETH.times(newEthPrice)
    const token0High = token0Open.gt(token0Close) ? token0Open : token0Close
    const token0Low = token0Open.lt(token0Close) ? token0Open : token0Close
    const token1Open = TEST_WETH_DERIVED_ETH.times(TEST_ETH_PRICE_USD)
    const token1Close = newToken1DerivedETH.times(newEthPrice)
    const token1High = token1Open.gt(token1Close) ? token1Open : token1Close
    const token1Low = token1Open.lt(token1Close) ? token1Open : token1Close
    // each token's TVL at its post-swap price
    const token0TvlUSD = reserveDelta0.times(newToken0DerivedETH).times(newEthPrice)
    const token1TvlUSD = reserveDelta1.times(newToken1DerivedETH).times(newEthPrice)

    assertObjectMatches('PoolManager', TEST_CONFIG.poolManagerAddress, [
      ['txCount', '1'],
      ['totalVolumeETH', amountTotalETHTRacked.toString()],
      ['totalVolumeUSD', amountTotalUSDTracked.toString()],
      ['untrackedVolumeUSD', amountTotalUSDUntracked.toString()],
      ['totalLpFeesETH', feesETH.toString()],
      ['totalLpFeesUSD', feesUSD.toString()],
      ['totalValueLockedETH', totalValueLockedETH.toString()],
      ['totalValueLockedUSD', totalValueLockedETH.times(newEthPrice).toString()],
    ])

    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['volumeToken0', amount0Abs.toString()],
      ['volumeToken1', amount1Abs.toString()],
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['untrackedVolumeUSD', amountTotalUSDUntracked.toString()],
      ['lpFeesUSD', feesUSD.toString()],
      ['txCount', '1'],
      ['feeTier', POOL_FEE_TIER_05.toString()],
      ['poolFee', POOL_FEE_TIER_05.toString()],
      ['lpFee', POOL_FEE_TIER_05.toString()],
      ['ascntProtocolFee', '0'],
      ['totalSwapFee', POOL_FEE_TIER_05.toString()],
      ['lastSwapTimestamp', MOCK_EVENT.block.timestamp.toString()],
      ['lpFeesToken0', pipsOf(amount0Abs, POOL_FEE_TIER_05).toString()],
      ['lpFeesToken1', '0'],
      ['uniswapProtocolFeesUSD', '0'],
      ['uniswapProtocolFeesToken0', '0'],
      ['uniswapProtocolFeesToken1', '0'],
      ['liquidity', SWAP_FIXTURE.liquidity.toString()],
      ['tick', SWAP_FIXTURE.tick.toString()],
      ['sqrtPrice', SWAP_FIXTURE.sqrtPriceX96.toString()],
      ['totalValueLockedToken0', reserveDelta0.toString()],
      ['totalValueLockedToken1', reserveDelta1.toString()],
      ['token0Price', newPoolPrices[0].toString()],
      ['token1Price', newPoolPrices[1].toString()],
      ['totalValueLockedETH', totalValueLockedETH.toString()],
      ['totalValueLockedUSD', totalValueLockedETH.times(newEthPrice).toString()],
    ])

    assertObjectMatches('Token', USDC_MAINNET_FIXTURE.address, [
      ['volume', amount0Abs.toString()],
      ['totalValueLocked', reserveDelta0.toString()],
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['untrackedVolumeUSD', amountTotalUSDUntracked.toString()],
      ['lpFeesUSD', feesUSD.toString()],
      ['txCount', '1'],
      ['derivedETH', newToken0DerivedETH.toString()],
      ['totalValueLockedUSD', token0TvlUSD.toString()],
    ])

    assertObjectMatches('Token', WETH_MAINNET_FIXTURE.address, [
      ['volume', amount1Abs.toString()],
      ['totalValueLocked', reserveDelta1.toString()],
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['untrackedVolumeUSD', amountTotalUSDUntracked.toString()],
      ['lpFeesUSD', feesUSD.toString()],
      ['txCount', '1'],
      ['derivedETH', newToken1DerivedETH.toString()],
      ['totalValueLockedUSD', token1TvlUSD.toString()],
    ])

    assertObjectMatches('Swap', MOCK_EVENT.transaction.hash.toHexString() + '-' + MOCK_EVENT.logIndex.toString(), [
      ['transaction', MOCK_EVENT.transaction.hash.toHexString()],
      ['timestamp', MOCK_EVENT.block.timestamp.toString()],
      ['pool', USDC_WETH_POOL_ID],
      ['token0', USDC_MAINNET_FIXTURE.address],
      ['token1', WETH_MAINNET_FIXTURE.address],
      ['sender', SWAP_FIXTURE.sender.toHexString()],
      ['origin', MOCK_EVENT.transaction.from.toHexString()],
      // ['recipient', SWAP_FIXTURE.recipient.toHexString()],
      ['amount0', amount0.toString()],
      ['amount1', amount1.toString()],
      ['amountUSD', amountTotalUSDTracked.toString()],
      ['tick', SWAP_FIXTURE.tick.toString()],
      ['sqrtPriceX96', SWAP_FIXTURE.sqrtPriceX96.toString()],
      ['logIndex', MOCK_EVENT.logIndex.toString()],
      ['poolFee', POOL_FEE_TIER_05.toString()],
      ['lpFee', POOL_FEE_TIER_05.toString()],
      ['ascntProtocolFee', '0'],
      ['uniswapProtocolFee', '0'],
      ['totalSwapFee', POOL_FEE_TIER_05.toString()],
    ])

    const dayId = MOCK_EVENT.block.timestamp.toI32() / 86400
    const hourId = MOCK_EVENT.block.timestamp.toI32() / 3600

    assertObjectMatches('PoolDayData', USDC_WETH_POOL_ID + '-' + dayId.toString(), [
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['volumeToken0', amount0Abs.toString()],
      ['volumeToken1', amount1Abs.toString()],
      ['lpFeesUSD', feesUSD.toString()],
      ['open', poolOpen.toString()],
      ['high', poolHigh.toString()],
      ['low', poolLow.toString()],
      ['close', poolClose.toString()],
      ['token0Price', poolClose.toString()],
    ])

    assertObjectMatches('PoolHourData', USDC_WETH_POOL_ID + '-' + hourId.toString(), [
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['volumeToken0', amount0Abs.toString()],
      ['volumeToken1', amount1Abs.toString()],
      ['lpFeesUSD', feesUSD.toString()],
      ['open', poolOpen.toString()],
      ['high', poolHigh.toString()],
      ['low', poolLow.toString()],
      ['close', poolClose.toString()],
      ['token0Price', poolClose.toString()],
    ])

    assertObjectMatches('TokenDayData', USDC_MAINNET_FIXTURE.address + '-' + dayId.toString(), [
      ['volume', amount0Abs.toString()],
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['untrackedVolumeUSD', amountTotalUSDTracked.toString()],
      ['lpFeesUSD', feesUSD.toString()],
      ['open', token0Open.toString()],
      ['high', token0High.toString()],
      ['low', token0Low.toString()],
      ['close', token0Close.toString()],
    ])

    assertObjectMatches('TokenDayData', WETH_MAINNET_FIXTURE.address + '-' + dayId.toString(), [
      ['volume', amount1Abs.toString()],
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['untrackedVolumeUSD', amountTotalUSDTracked.toString()],
      ['lpFeesUSD', feesUSD.toString()],
      ['open', token1Open.toString()],
      ['high', token1High.toString()],
      ['low', token1Low.toString()],
      ['close', token1Close.toString()],
    ])

    assertObjectMatches('TokenHourData', USDC_MAINNET_FIXTURE.address + '-' + hourId.toString(), [
      ['volume', amount0Abs.toString()],
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['untrackedVolumeUSD', amountTotalUSDTracked.toString()],
      ['lpFeesUSD', feesUSD.toString()],
      ['open', token0Open.toString()],
      ['high', token0High.toString()],
      ['low', token0Low.toString()],
      ['close', token0Close.toString()],
    ])

    assertObjectMatches('TokenHourData', WETH_MAINNET_FIXTURE.address + '-' + hourId.toString(), [
      ['volume', amount1Abs.toString()],
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['untrackedVolumeUSD', amountTotalUSDTracked.toString()],
      ['lpFeesUSD', feesUSD.toString()],
      ['open', token1Open.toString()],
      ['high', token1High.toString()],
      ['low', token1Low.toString()],
      ['close', token1Close.toString()],
    ])
  })
})

// Standalone OHLC check through the real handler, isolated from the asserts
// above (a known native-runner precision mismatch aborts that test early, which
// would otherwise mask these). The candle must record THIS swap's post-price as
// the close — before the lag fix it recorded the last-saved (pre-swap) price.
describe('handleSwap candle OHLC (no one-swap lag)', () => {
  beforeAll(() => {
    clearStore()
    invokePoolCreatedWithMockedEthCalls(MOCK_EVENT, TEST_CONFIG)

    const bundle = new Bundle('1')
    bundle.ethPriceUSD = TEST_ETH_PRICE_USD
    bundle.save()

    const usdcEntity = Token.load(USDC_MAINNET_FIXTURE.address)!
    usdcEntity.derivedETH = TEST_USDC_DERIVED_ETH
    usdcEntity.save()

    const wethEntity = Token.load(WETH_MAINNET_FIXTURE.address)!
    wethEntity.derivedETH = TEST_WETH_DERIVED_ETH
    wethEntity.save()
  })

  test('close and token0Price reflect the current swap post-price; open keeps the entering price', () => {
    const token0 = Token.load(USDC_MAINNET_FIXTURE.address)!
    const token1 = Token.load(WETH_MAINNET_FIXTURE.address)!

    // The bucket was created by handleInitialize at the init price — that is
    // the pool's entering price for this bucket and must survive as its open.
    const initPoolPrices = sqrtPriceX96ToTokenPrices(
      BigInt.fromString(USDC_WETH_05_MAINNET_POOL_FIXTURE.sqrtPrice),
      token0,
      token1,
      TEST_CONFIG.nativeTokenDetails,
    )
    const newPoolPrices = sqrtPriceX96ToTokenPrices(
      SWAP_FIXTURE.sqrtPriceX96,
      token0,
      token1,
      TEST_CONFIG.nativeTokenDetails,
    )

    const dayId = MOCK_EVENT.block.timestamp.toI32() / 86400
    const hourId = MOCK_EVENT.block.timestamp.toI32() / 3600
    const dayEntity = USDC_WETH_POOL_ID + '-' + dayId.toString()
    const hourEntity = USDC_WETH_POOL_ID + '-' + hourId.toString()

    // handleInitialize created the bucket, but init is not a swap — no candle yet.
    const preSwap = PoolHourData.load(hourEntity)!
    assert.assertTrue(preSwap.open === null)
    assert.assertTrue(preSwap.close === null)

    handleSwapHelper(SWAP_EVENT, TEST_CONFIG)

    assert.fieldEquals('PoolHourData', hourEntity, 'open', initPoolPrices[0].toString())
    assert.fieldEquals('PoolHourData', hourEntity, 'close', newPoolPrices[0].toString())
    assert.fieldEquals('PoolHourData', hourEntity, 'token0Price', newPoolPrices[0].toString())
    assert.fieldEquals('PoolDayData', dayEntity, 'open', initPoolPrices[0].toString())
    assert.fieldEquals('PoolDayData', dayEntity, 'close', newPoolPrices[0].toString())
    assert.fieldEquals('PoolDayData', dayEntity, 'token0Price', newPoolPrices[0].toString())

    // Token buckets are created BY this swap: their open must be the entering
    // (pre-swap) USD price captured in swap.ts before bundle/derivedETH mutate.
    const token0Open = TEST_USDC_DERIVED_ETH.times(TEST_ETH_PRICE_USD)
    const token1Open = TEST_WETH_DERIVED_ETH.times(TEST_ETH_PRICE_USD)
    const usdcHour = USDC_MAINNET_FIXTURE.address + '-' + hourId.toString()
    const usdcDay = USDC_MAINNET_FIXTURE.address + '-' + dayId.toString()
    const wethHour = WETH_MAINNET_FIXTURE.address + '-' + hourId.toString()
    const wethDay = WETH_MAINNET_FIXTURE.address + '-' + dayId.toString()
    assert.fieldEquals('TokenHourData', usdcHour, 'open', token0Open.toString())
    assert.fieldEquals('TokenDayData', usdcDay, 'open', token0Open.toString())
    assert.fieldEquals('TokenHourData', wethHour, 'open', token1Open.toString())
    assert.fieldEquals('TokenDayData', wethDay, 'open', token1Open.toString())
  })

  test('a new hour bucket opens at the previous swap post-price (entering price captured pre-mutation)', () => {
    const token0 = Token.load(USDC_MAINNET_FIXTURE.address)!
    const token1 = Token.load(WETH_MAINNET_FIXTURE.address)!

    const swap1Prices = sqrtPriceX96ToTokenPrices(
      SWAP_FIXTURE.sqrtPriceX96,
      token0,
      token1,
      TEST_CONFIG.nativeTokenDetails,
    )
    const swap2Sqrt = BigInt.fromString('79228162514264337593543950336') // 2^96, distinct from swap 1
    const swap2Prices = sqrtPriceX96ToTokenPrices(swap2Sqrt, token0, token1, TEST_CONFIG.nativeTokenDetails)

    // One hour later: this swap creates the next hour bucket. The pool sat at
    // swap 1's post-price entering it, so that must be the open. If swap.ts
    // captured the entering price AFTER applying the swap, the open would
    // (wrongly) equal swap 2's own post-price.
    const ts2 = MOCK_EVENT.block.timestamp.plus(BigInt.fromI32(3600))
    handleSwapHelper(createSwapEvent(swap2Sqrt, ts2), TEST_CONFIG)

    const hour2Entity = USDC_WETH_POOL_ID + '-' + (ts2.toI32() / 3600).toString()
    assert.fieldEquals('PoolHourData', hour2Entity, 'open', swap1Prices[0].toString())
    assert.fieldEquals('PoolHourData', hour2Entity, 'close', swap2Prices[0].toString())
  })
})

// Uniswap's protocol fee is charged on top of the LP fee and folded into Swap.fee
// (calculateSwapFee = protocolFee + lpFee - floor(protocolFee * lpFee / 1e6)).
// The handler must leave feeTier alone, bill LP fees on the LP share only,
// and keep every fee out of TVL.
describe('handleSwap with a Uniswap protocol fee on a static pool', () => {
  // 125 pips in both directions: 125 | (125 << 12)
  const PACKED_125_125: i32 = 512125
  // calculateSwapFee(125, 500) = 125 + 500 - floor(62500 / 1e6) = 625
  const SWAP_FEE_625: i32 = 625

  beforeAll(() => {
    setUpPoolWithPrices()
    handleProtocolFeeUpdated(createProtocolFeeUpdatedEvent(PACKED_125_125))
  })

  test('feeTier stays the tier, lpFeesUSD bills only the LP share, TVL nets the whole swap fee', () => {
    const trackedUSD = trackedUSDBeforeSwap(SWAP_FIXTURE.amount0, SWAP_FIXTURE.amount1)
    // LP take = swapFee - protocolFee = 625 - 125 = 500 pips of the input
    const feesUSD = lpFeesUSD(trackedUSD, 500)

    // token0 is the input (swapper delta negative); token1 leaves in full
    const grossInput0 = convertTokenToDecimal(
      SWAP_FIXTURE.amount0.abs(),
      BigInt.fromString(USDC_MAINNET_FIXTURE.decimals),
    )
    const reserveDelta0 = netOfSwapFee(grossInput0, SWAP_FEE_625)
    const reserveDelta1 = convertTokenToDecimal(
      SWAP_FIXTURE.amount1,
      BigInt.fromString(WETH_MAINNET_FIXTURE.decimals),
    ).times(BigDecimal.fromString('-1'))

    const event = createSwapEventWith(
      SWAP_FIXTURE.sqrtPriceX96,
      MOCK_EVENT.block.timestamp,
      SWAP_FIXTURE.amount0,
      SWAP_FIXTURE.amount1,
      SWAP_FEE_625,
    )
    handleSwapHelper(event, TEST_CONFIG)

    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['feeTier', POOL_FEE_TIER_05.toString()],
      ['poolFee', POOL_FEE_TIER_05.toString()],
      ['lpFee', POOL_FEE_TIER_05.toString()],
      ['ascntProtocolFee', '0'],
      ['totalSwapFee', SWAP_FEE_625.toString()],
      ['uniswapProtocolFeeZeroForOne', '125'],
      ['uniswapProtocolFeeOneForZero', '125'],
      ['lpFeesUSD', feesUSD.toString()],
      ['lpFeesToken0', pipsOf(grossInput0, 500).toString()],
      ['lpFeesToken1', '0'],
      ['uniswapProtocolFeesUSD', lpFeesUSD(trackedUSD, 125).toString()],
      ['uniswapProtocolFeesToken0', pipsOf(grossInput0, 125).toString()],
      ['uniswapProtocolFeesToken1', '0'],
      ['totalValueLockedToken0', reserveDelta0.toString()],
      ['totalValueLockedToken1', reserveDelta1.toString()],
    ])
    assertObjectMatches('Swap', SWAP_ENTITY_ID, [
      ['poolFee', POOL_FEE_TIER_05.toString()],
      ['lpFee', POOL_FEE_TIER_05.toString()],
      ['ascntProtocolFee', '0'],
      ['uniswapProtocolFee', '125'],
      ['totalSwapFee', SWAP_FEE_625.toString()],
    ])
    assertObjectMatches('PoolManager', TEST_CONFIG.poolManagerAddress, [['totalLpFeesUSD', feesUSD.toString()]])
    assertObjectMatches('Token', USDC_MAINNET_FIXTURE.address, [
      ['lpFeesUSD', feesUSD.toString()],
      ['totalValueLocked', reserveDelta0.toString()],
    ])
    assertObjectMatches('Token', WETH_MAINNET_FIXTURE.address, [
      ['lpFeesUSD', feesUSD.toString()],
      ['totalValueLocked', reserveDelta1.toString()],
    ])
  })
})

describe('handleSwap picks the protocol fee of the swap direction', () => {
  // zeroForOne 100 pips, oneForZero 200 pips: 100 | (200 << 12)
  const PACKED_100_200: i32 = 819300
  // oneForZero: calculateSwapFee(200, 500) = 200 + 500 - floor(100000 / 1e6) = 700
  const SWAP_FEE_700: i32 = 700

  beforeAll(() => {
    setUpPoolWithPrices()
    handleProtocolFeeUpdated(createProtocolFeeUpdatedEvent(PACKED_100_200))
  })

  test('a oneForZero swap uses the oneForZero rate', () => {
    // swapper pays token1 (negative delta) and receives token0
    const amount0 = BigInt.fromString('10000')
    const amount1 = BigInt.fromString('-10007')
    const trackedUSD = trackedUSDBeforeSwap(amount0, amount1)
    // LP take = 700 - 200 = 500 pips; using the zeroForOne rate would give 600
    const feesUSD = lpFeesUSD(trackedUSD, 500)

    const reserveDelta0 = convertTokenToDecimal(amount0, BigInt.fromString(USDC_MAINNET_FIXTURE.decimals)).times(
      BigDecimal.fromString('-1'),
    )
    const grossInput1 = convertTokenToDecimal(amount1.abs(), BigInt.fromString(WETH_MAINNET_FIXTURE.decimals))
    const reserveDelta1 = netOfSwapFee(grossInput1, SWAP_FEE_700)

    const event = createSwapEventWith(
      SWAP_FIXTURE.sqrtPriceX96,
      MOCK_EVENT.block.timestamp,
      amount0,
      amount1,
      SWAP_FEE_700,
    )
    handleSwapHelper(event, TEST_CONFIG)

    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['feeTier', POOL_FEE_TIER_05.toString()],
      ['poolFee', POOL_FEE_TIER_05.toString()],
      ['lpFee', POOL_FEE_TIER_05.toString()],
      ['totalSwapFee', SWAP_FEE_700.toString()],
      ['lpFeesUSD', feesUSD.toString()],
      ['lpFeesToken0', '0'],
      ['lpFeesToken1', pipsOf(grossInput1, 500).toString()],
      ['uniswapProtocolFeesUSD', lpFeesUSD(trackedUSD, 200).toString()],
      ['uniswapProtocolFeesToken0', '0'],
      ['uniswapProtocolFeesToken1', pipsOf(grossInput1, 200).toString()],
      ['totalValueLockedToken0', reserveDelta0.toString()],
      ['totalValueLockedToken1', reserveDelta1.toString()],
    ])
    assertObjectMatches('Swap', SWAP_ENTITY_ID, [
      ['uniswapProtocolFee', '200'],
      ['totalSwapFee', SWAP_FEE_700.toString()],
    ])
  })
})

describe('handleSwap on a dynamic-fee pool', () => {
  // 499 pips in both directions: 499 | (499 << 12) — the mainnet ETH/MORPHO value
  const PACKED_499_499: i32 = 2044403
  const DYNAMIC_FEE_SENTINEL = '8388608'

  beforeAll(() => {
    setUpPoolWithPrices()
    const pool = Pool.load(USDC_WETH_POOL_ID)!
    pool.isDynamicFee = true
    pool.feeTier = BigInt.fromString(DYNAMIC_FEE_SENTINEL)
    pool.save()
  })

  test('with no protocol fee, poolFee is Swap.fee and feeTier stays the flag', () => {
    const event = createSwapEventWith(
      SWAP_FIXTURE.sqrtPriceX96,
      MOCK_EVENT.block.timestamp,
      SWAP_FIXTURE.amount0,
      SWAP_FIXTURE.amount1,
      1234,
    )
    handleSwapHelper(event, TEST_CONFIG)

    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['feeTier', DYNAMIC_FEE_SENTINEL],
      ['poolFee', '1234'],
      ['lpFee', '1234'],
      ['ascntProtocolFee', '0'],
      ['totalSwapFee', '1234'],
    ])
  })

  test('with a protocol fee, poolFee is the LP fee recovered from Swap.fee', () => {
    handleProtocolFeeUpdated(createProtocolFeeUpdatedEvent(PACKED_499_499))
    const feesBefore = Pool.load(USDC_WETH_POOL_ID)!.lpFeesUSD

    const trackedUSD = trackedUSDBeforeSwap(SWAP_FIXTURE.amount0, SWAP_FIXTURE.amount1)
    // hook charged 2999; calculateSwapFee(499, 2999) = 3497; LPs get 3497 - 499 = 2998 pips
    const feesUSD = feesBefore.plus(lpFeesUSD(trackedUSD, 2998))

    const event = createSwapEventWith(
      SWAP_FIXTURE.sqrtPriceX96,
      MOCK_EVENT.block.timestamp,
      SWAP_FIXTURE.amount0,
      SWAP_FIXTURE.amount1,
      3497,
    )
    handleSwapHelper(event, TEST_CONFIG)

    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['feeTier', DYNAMIC_FEE_SENTINEL],
      ['poolFee', '2999'],
      ['lpFee', '2999'],
      ['ascntProtocolFee', '0'],
      ['totalSwapFee', '3498'],
      ['lpFeesUSD', feesUSD.toString()],
    ])
  })
})

// hook fee 3000 pips with a 20% Ascnt cut: LP override 2400, cut 600
const ASCNT_DYNAMIC_FEE: i32 = 3000
const ASCNT_LP_OVERRIDE: i32 = 2400

// Module level on purpose: a function declared inside a describe callback and
// called from its tests traps matchstick with "wasm trap: uninitialized element".
function stageBeforeSwap(): void {
  ascntBeforeSwapCore(
    MOCK_EVENT,
    USDC_WETH_POOL_ID,
    BigInt.fromI32(1),
    BigInt.fromI32(0),
    BigInt.fromI32(0),
    BigInt.fromI32(ASCNT_DYNAMIC_FEE),
  )
}

describe('handleSwap on an Ascnt pool', () => {
  // 499 pips both ways: 499 | (499 << 12)
  const PACKED_499_499: i32 = 2044403

  beforeAll(() => {
    setUpPoolWithPrices()
    const pool = Pool.load(USDC_WETH_POOL_ID)!
    pool.isDynamicFee = true
    pool.isAscntPool = true
    pool.feeTier = BigInt.fromString('8388608')
    pool.save()
  })

  test('poolFee is the hook fee, lpFee the override, ascntProtocolFee the gap; Swap.fee never holds the cut', () => {
    stageBeforeSwap()
    const trackedUSD = trackedUSDBeforeSwap(SWAP_FIXTURE.amount0, SWAP_FIXTURE.amount1)
    const feesUSD = lpFeesUSD(trackedUSD, ASCNT_LP_OVERRIDE)

    // no Uniswap fee, so Swap.fee is the LP override itself
    const event = createSwapEventWith(
      SWAP_FIXTURE.sqrtPriceX96,
      MOCK_EVENT.block.timestamp,
      SWAP_FIXTURE.amount0,
      SWAP_FIXTURE.amount1,
      ASCNT_LP_OVERRIDE,
    )
    handleSwapHelper(event, TEST_CONFIG)

    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['feeTier', '8388608'],
      ['poolFee', '3000'],
      ['lpFee', '2400'],
      ['ascntProtocolFee', '600'],
      ['totalSwapFee', '3000'],
      ['dynamicFeePips', '3000'],
      ['lpFeesUSD', feesUSD.toString()],
      ['uniswapProtocolFeesUSD', '0'],
    ])
    assertObjectMatches('Swap', SWAP_ENTITY_ID, [
      ['poolFee', '3000'],
      ['lpFee', '2400'],
      ['ascntProtocolFee', '600'],
      ['uniswapProtocolFee', '0'],
      ['totalSwapFee', '3000'],
      ['dynamicFeePips', '3000'],
    ])
  })

  test('with a Uniswap fee on top, lpFee is recovered from Swap.fee and the cut still comes off poolFee', () => {
    handleProtocolFeeUpdated(createProtocolFeeUpdatedEvent(PACKED_499_499))
    stageBeforeSwap()
    const feesBefore = Pool.load(USDC_WETH_POOL_ID)!.lpFeesUSD
    const trackedUSD = trackedUSDBeforeSwap(SWAP_FIXTURE.amount0, SWAP_FIXTURE.amount1)
    // calculateSwapFee(499, 2400) = 499 + 2400 - floor(1197600 / 1e6) = 2898; LPs get 2898 - 499 = 2399 pips
    const feesUSD = feesBefore.plus(lpFeesUSD(trackedUSD, 2399))

    const event = createSwapEventWith(
      SWAP_FIXTURE.sqrtPriceX96,
      MOCK_EVENT.block.timestamp,
      SWAP_FIXTURE.amount0,
      SWAP_FIXTURE.amount1,
      2898,
    )
    handleSwapHelper(event, TEST_CONFIG)

    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['feeTier', '8388608'],
      ['poolFee', '3000'],
      ['lpFee', '2400'],
      ['ascntProtocolFee', '600'],
      ['totalSwapFee', '3499'],
      ['lpFeesUSD', feesUSD.toString()],
    ])
    assertObjectMatches('Swap', SWAP_ENTITY_ID, [
      ['lpFee', '2400'],
      ['uniswapProtocolFee', '499'],
      ['totalSwapFee', '3499'],
    ])
  })
})

// getNativePriceInUSD and findNativePerToken read pools from the store, so the
// swapped pool must be saved before pricing runs, or the ETH price (and any token
// priced through this pool) lags one swap behind, as upstream's does.
describe('handleSwap prices from the post-swap state (no one-swap lag)', () => {
  beforeAll(() => {
    setUpPoolWithPrices()
  })

  test('the ETH price and lastSwapTimestamp follow the current swap, not the previous one', () => {
    const token0 = Token.load(USDC_MAINNET_FIXTURE.address)!
    const token1 = Token.load(WETH_MAINNET_FIXTURE.address)!
    const swap1Prices = sqrtPriceX96ToTokenPrices(
      SWAP_FIXTURE.sqrtPriceX96,
      token0,
      token1,
      TEST_CONFIG.nativeTokenDetails,
    )
    const swap2Sqrt = BigInt.fromString('79228162514264337593543950336') // 2^96, distinct from swap 1
    const swap2Prices = sqrtPriceX96ToTokenPrices(swap2Sqrt, token0, token1, TEST_CONFIG.nativeTokenDetails)
    // USDC is token0 of the ETH/USD pool, so the pool's token0Price is the ETH price
    assert.assertTrue(swap1Prices[0] != swap2Prices[0])

    handleSwapHelper(SWAP_EVENT, TEST_CONFIG)
    assert.fieldEquals('Bundle', '1', 'ethPriceUSD', swap1Prices[0].toString())
    assert.fieldEquals('Pool', USDC_WETH_POOL_ID, 'lastSwapTimestamp', MOCK_EVENT.block.timestamp.toString())

    const ts2 = MOCK_EVENT.block.timestamp.plus(BigInt.fromI32(60))
    handleSwapHelper(createSwapEvent(swap2Sqrt, ts2), TEST_CONFIG)
    assert.fieldEquals('Bundle', '1', 'ethPriceUSD', swap2Prices[0].toString())
    assert.fieldEquals('Pool', USDC_WETH_POOL_ID, 'lastSwapTimestamp', ts2.toString())
    // USDC is a stablecoin, so its derivedETH is 1 / the post-swap ETH price
    const usdcDerivedETH = safeDiv(ONE_BD, swap2Prices[0])
    assert.fieldEquals('Token', USDC_MAINNET_FIXTURE.address, 'derivedETH', usdcDerivedETH.toString())
  })
})
