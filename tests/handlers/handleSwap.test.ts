import { Address, BigDecimal, BigInt, Bytes, ethereum } from '@graphprotocol/graph-ts'
import { assert, beforeAll, clearStore, describe, newMockEvent, test } from 'matchstick-as'

import { handleSwapHelper } from '../../src/mappings/swap'
import { Swap } from '../../src/types/PoolManager/PoolManager'
import { Bundle, PoolHourData, Token } from '../../src/types/schema'
import { ZERO_BD } from '../../src/utils/constants'
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
      new ethereum.EventParam('amount0', ethereum.Value.fromSignedBigInt(SWAP_FIXTURE.amount0)),
      new ethereum.EventParam('amount1', ethereum.Value.fromSignedBigInt(SWAP_FIXTURE.amount1)),
      new ethereum.EventParam('sqrtPriceX96', ethereum.Value.fromSignedBigInt(sqrtPriceX96)),
      new ethereum.EventParam('liquidity', ethereum.Value.fromSignedBigInt(SWAP_FIXTURE.liquidity)),
      new ethereum.EventParam('tick', ethereum.Value.fromI32(SWAP_FIXTURE.tick)),
      new ethereum.EventParam('fee', ethereum.Value.fromI32(SWAP_FIXTURE.fee)),
    ],
    MOCK_EVENT.receipt,
  )
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

    const feeTierBD = BigDecimal.fromString(POOL_FEE_TIER_05.toString())
    const feesETH = amountTotalETHTRacked.times(feeTierBD).div(BigDecimal.fromString('1000000'))
    const feesUSD = amountTotalUSDTracked.times(feeTierBD).div(BigDecimal.fromString('1000000'))

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
      TEST_CONFIG.minimumNativeLocked,
    )
    const newToken1DerivedETH = findNativePerToken(
      token1,
      TEST_CONFIG.wrappedNativeAddress,
      TEST_CONFIG.stablecoinAddresses,
      TEST_CONFIG.minimumNativeLocked,
    )

    const totalValueLockedETH = amount0.times(newToken0DerivedETH).plus(amount1.times(newToken1DerivedETH))

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

    assertObjectMatches('PoolManager', TEST_CONFIG.poolManagerAddress, [
      ['txCount', '1'],
      ['totalVolumeETH', amountTotalETHTRacked.toString()],
      ['totalVolumeUSD', amountTotalUSDTracked.toString()],
      ['untrackedVolumeUSD', amountTotalUSDUntracked.toString()],
      ['totalFeesETH', feesETH.toString()],
      ['totalFeesUSD', feesUSD.toString()],
      ['totalValueLockedETH', totalValueLockedETH.toString()],
      ['totalValueLockedUSD', totalValueLockedETH.times(newEthPrice).toString()],
    ])

    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['volumeToken0', amount0Abs.toString()],
      ['volumeToken1', amount1Abs.toString()],
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['untrackedVolumeUSD', amountTotalUSDUntracked.toString()],
      ['feesUSD', feesUSD.toString()],
      ['txCount', '1'],
      ['liquidity', SWAP_FIXTURE.liquidity.toString()],
      ['tick', SWAP_FIXTURE.tick.toString()],
      ['sqrtPrice', SWAP_FIXTURE.sqrtPriceX96.toString()],
      ['totalValueLockedToken0', amount0.toString()],
      ['totalValueLockedToken1', amount1.toString()],
      ['token0Price', newPoolPrices[0].toString()],
      ['token1Price', newPoolPrices[1].toString()],
      ['totalValueLockedETH', totalValueLockedETH.toString()],
      ['totalValueLockedUSD', totalValueLockedETH.times(newEthPrice).toString()],
    ])

    assertObjectMatches('Token', USDC_MAINNET_FIXTURE.address, [
      ['volume', amount0Abs.toString()],
      ['totalValueLocked', amount0.toString()],
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['untrackedVolumeUSD', amountTotalUSDUntracked.toString()],
      ['feesUSD', feesUSD.toString()],
      ['txCount', '1'],
      ['derivedETH', newToken0DerivedETH.toString()],
      [
        'totalValueLockedUSD',
        amount0
          .times(newToken0DerivedETH)
          .times(newEthPrice)
          .toString(),
      ],
    ])

    assertObjectMatches('Token', WETH_MAINNET_FIXTURE.address, [
      ['volume', amount1Abs.toString()],
      ['totalValueLocked', amount1.toString()],
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['untrackedVolumeUSD', amountTotalUSDUntracked.toString()],
      ['feesUSD', feesUSD.toString()],
      ['txCount', '1'],
      ['derivedETH', newToken1DerivedETH.toString()],
      [
        'totalValueLockedUSD',
        amount1
          .times(newToken1DerivedETH)
          .times(newEthPrice)
          .toString(),
      ],
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
    ])

    const dayId = MOCK_EVENT.block.timestamp.toI32() / 86400
    const hourId = MOCK_EVENT.block.timestamp.toI32() / 3600

    assertObjectMatches('UniswapDayData', dayId.toString(), [
      ['volumeETH', amountTotalETHTRacked.toString()],
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['feesUSD', feesUSD.toString()],
    ])

    assertObjectMatches('PoolDayData', USDC_WETH_POOL_ID + '-' + dayId.toString(), [
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['volumeToken0', amount0Abs.toString()],
      ['volumeToken1', amount1Abs.toString()],
      ['feesUSD', feesUSD.toString()],
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
      ['feesUSD', feesUSD.toString()],
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
      ['feesUSD', feesUSD.toString()],
      ['open', token0Open.toString()],
      ['high', token0High.toString()],
      ['low', token0Low.toString()],
      ['close', token0Close.toString()],
    ])

    assertObjectMatches('TokenDayData', WETH_MAINNET_FIXTURE.address + '-' + dayId.toString(), [
      ['volume', amount1Abs.toString()],
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['untrackedVolumeUSD', amountTotalUSDTracked.toString()],
      ['feesUSD', feesUSD.toString()],
      ['open', token1Open.toString()],
      ['high', token1High.toString()],
      ['low', token1Low.toString()],
      ['close', token1Close.toString()],
    ])

    assertObjectMatches('TokenHourData', USDC_MAINNET_FIXTURE.address + '-' + hourId.toString(), [
      ['volume', amount0Abs.toString()],
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['untrackedVolumeUSD', amountTotalUSDTracked.toString()],
      ['feesUSD', feesUSD.toString()],
      ['open', token0Open.toString()],
      ['high', token0High.toString()],
      ['low', token0Low.toString()],
      ['close', token0Close.toString()],
    ])

    assertObjectMatches('TokenHourData', WETH_MAINNET_FIXTURE.address + '-' + hourId.toString(), [
      ['volume', amount1Abs.toString()],
      ['volumeUSD', amountTotalUSDTracked.toString()],
      ['untrackedVolumeUSD', amountTotalUSDTracked.toString()],
      ['feesUSD', feesUSD.toString()],
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
