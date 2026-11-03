import { Address, BigDecimal, BigInt, Bytes, ethereum } from '@graphprotocol/graph-ts'
import { afterEach, assert, beforeEach, clearStore, describe, test } from 'matchstick-as'

import { handleModifyLiquidityHelper } from '../../src/mappings/modifyLiquidity'
import { ModifyLiquidity } from '../../src/types/PoolManager/PoolManager'
import {
  Bundle,
  ModifyLiquidity as ModifyLiquidityEntity,
  Pool,
  PoolHourData,
  Position,
  Token,
} from '../../src/types/schema'
import { ONE_BD } from '../../src/utils/constants'
import { convertTokenToDecimal, fastExponentiation, safeDiv } from '../../src/utils/index'
import { TickMath } from '../../src/utils/liquidityMath/tickMath'
import { initPositionState } from '../../src/utils/position'
import {
  assertObjectMatches,
  invokePoolCreatedWithMockedEthCalls,
  MOCK_EVENT,
  POSITION_FIXTURE,
  TEST_CONFIG,
  TEST_ETH_PRICE_USD,
  TEST_USDC_DERIVED_ETH,
  TEST_WETH_DERIVED_ETH,
  USDC_MAINNET_FIXTURE,
  USDC_WETH_POOL_ID,
  WETH_MAINNET_FIXTURE,
} from './constants'

class ModifyLiquidityFixture {
  id: string
  sender: Address
  tickLower: i32
  tickUpper: i32
  liquidityDelta: BigInt
}

const MODIFY_LIQUIDITY_FIXTURE_ADD: ModifyLiquidityFixture = {
  id: USDC_WETH_POOL_ID,
  sender: Address.fromString('0x39BF2eFF94201cfAA471932655404F63315147a4'), // Provided sender address
  tickLower: -600,
  tickUpper: 600,
  liquidityDelta: BigInt.fromString('10000000000000000000000'), // Provided liquidity delta
}

const MODIFY_LIQUIDITY_FIXTURE_REMOVE: ModifyLiquidityFixture = {
  id: USDC_WETH_POOL_ID,
  sender: Address.fromString('0x39BF2eFF94201cfAA471932655404F63315147a4'), // Provided sender address
  tickLower: -600,
  tickUpper: 600,
  liquidityDelta: BigInt.fromString('-10000000000000000000000'), // Provided liquidity delta
}

const id = Bytes.fromHexString(USDC_WETH_POOL_ID) as Bytes

const MODIFY_LIQUIDITY_EVENT_ADD = new ModifyLiquidity(
  MOCK_EVENT.address,
  MOCK_EVENT.logIndex,
  MOCK_EVENT.transactionLogIndex,
  MOCK_EVENT.logType,
  MOCK_EVENT.block,
  MOCK_EVENT.transaction,
  [
    new ethereum.EventParam('id', ethereum.Value.fromFixedBytes(id)),
    new ethereum.EventParam('sender', ethereum.Value.fromAddress(MODIFY_LIQUIDITY_FIXTURE_ADD.sender)),
    new ethereum.EventParam('tickLower', ethereum.Value.fromI32(MODIFY_LIQUIDITY_FIXTURE_ADD.tickLower as i32)),
    new ethereum.EventParam('tickUpper', ethereum.Value.fromI32(MODIFY_LIQUIDITY_FIXTURE_ADD.tickUpper as i32)),
    new ethereum.EventParam(
      'liquidityDelta',
      ethereum.Value.fromSignedBigInt(MODIFY_LIQUIDITY_FIXTURE_ADD.liquidityDelta),
    ),
  ],
  MOCK_EVENT.receipt,
)

const MODIFY_LIQUIDITY_EVENT_REMOVE = new ModifyLiquidity(
  MOCK_EVENT.address,
  MOCK_EVENT.logIndex,
  MOCK_EVENT.transactionLogIndex,
  MOCK_EVENT.logType,
  MOCK_EVENT.block,
  MOCK_EVENT.transaction,
  [
    new ethereum.EventParam('id', ethereum.Value.fromFixedBytes(id)),
    new ethereum.EventParam('sender', ethereum.Value.fromAddress(MODIFY_LIQUIDITY_FIXTURE_REMOVE.sender)),
    new ethereum.EventParam('tickLower', ethereum.Value.fromI32(MODIFY_LIQUIDITY_FIXTURE_REMOVE.tickLower as i32)),
    new ethereum.EventParam('tickUpper', ethereum.Value.fromI32(MODIFY_LIQUIDITY_FIXTURE_REMOVE.tickUpper as i32)),
    new ethereum.EventParam(
      'liquidityDelta',
      ethereum.Value.fromSignedBigInt(MODIFY_LIQUIDITY_FIXTURE_REMOVE.liquidityDelta),
    ),
  ],
  MOCK_EVENT.receipt,
)

// Mainnet PositionManager; `handleModifyLiquidityHelper` takes it as a parameter so
// these tests do not depend on matchstick's idea of dataSource.network().
const POSITION_MANAGER = '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e'
// bytes32(tokenId) for POSITION_FIXTURE (tokenId 1), big-endian as the PositionManager passes it
const TOKEN_ID_1_SALT = '0x0000000000000000000000000000000000000000000000000000000000000001'
const ADD_DELTA = MODIFY_LIQUIDITY_FIXTURE_ADD.liquidityDelta
const REMOVE_DELTA = MODIFY_LIQUIDITY_FIXTURE_REMOVE.liquidityDelta
const MODIFY_LIQUIDITY_ID = MOCK_EVENT.transaction.hash.toHexString() + '-' + MOCK_EVENT.logIndex.toString()

// The principal of one fixture add / remove at the in-range price, as the handler
// computes it (the remove is a wei smaller: v4 rounds against the LP both ways).
const ADD_AMOUNT0 = convertTokenToDecimal(
  BigInt.fromString('295530108791371696809'),
  BigInt.fromString(USDC_MAINNET_FIXTURE.decimals),
)
const ADD_AMOUNT1 = convertTokenToDecimal(
  BigInt.fromString('295530108791371696809'),
  BigInt.fromString(WETH_MAINNET_FIXTURE.decimals),
)
const REMOVE_AMOUNT0 = convertTokenToDecimal(
  BigInt.fromString('-295530108791371696808'),
  BigInt.fromString(USDC_MAINNET_FIXTURE.decimals),
)
const REMOVE_AMOUNT1 = convertTokenToDecimal(
  BigInt.fromString('-295530108791371696808'),
  BigInt.fromString(WETH_MAINNET_FIXTURE.decimals),
)
const ADD_ETH = ADD_AMOUNT0.times(TEST_USDC_DERIVED_ETH).plus(ADD_AMOUNT1.times(TEST_WETH_DERIVED_ETH))
const ADD_USD = ADD_ETH.times(TEST_ETH_PRICE_USD)
const REMOVE_ETH = REMOVE_AMOUNT0.times(TEST_USDC_DERIVED_ETH).plus(REMOVE_AMOUNT1.times(TEST_WETH_DERIVED_ETH))
const REMOVE_USD = REMOVE_ETH.times(TEST_ETH_PRICE_USD)

// A fresh event per call: the handler reverses the salt bytes in place.
function positionManagerModifyEvent(liquidityDelta: BigInt): ModifyLiquidity {
  return new ModifyLiquidity(
    MOCK_EVENT.address,
    MOCK_EVENT.logIndex,
    MOCK_EVENT.transactionLogIndex,
    MOCK_EVENT.logType,
    MOCK_EVENT.block,
    MOCK_EVENT.transaction,
    [
      new ethereum.EventParam('id', ethereum.Value.fromFixedBytes(id)),
      new ethereum.EventParam('sender', ethereum.Value.fromAddress(Address.fromString(POSITION_MANAGER))),
      new ethereum.EventParam('tickLower', ethereum.Value.fromI32(MODIFY_LIQUIDITY_FIXTURE_ADD.tickLower as i32)),
      new ethereum.EventParam('tickUpper', ethereum.Value.fromI32(MODIFY_LIQUIDITY_FIXTURE_ADD.tickUpper as i32)),
      new ethereum.EventParam('liquidityDelta', ethereum.Value.fromSignedBigInt(liquidityDelta)),
      new ethereum.EventParam('salt', ethereum.Value.fromFixedBytes(Bytes.fromHexString(TOKEN_ID_1_SALT) as Bytes)),
    ],
    MOCK_EVENT.receipt,
  )
}

function setUpPoolAndPrices(): void {
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

// puts the pool's tick mid-range for the fixtures, so adds move pool.liquidity
function putPoolInRange(): Pool {
  const pool = Pool.load(USDC_WETH_POOL_ID)!
  pool.tick = BigInt.fromI32(MODIFY_LIQUIDITY_FIXTURE_ADD.tickLower + MODIFY_LIQUIDITY_FIXTURE_ADD.tickUpper).div(
    BigInt.fromI32(2),
  )
  pool.sqrtPrice = TickMath.getSqrtRatioAtTick(pool.tick!.toI32())
  pool.save()
  return pool
}

// the Position the NFT Transfer creates one log earlier, with zeroed accumulators
function storePosition(): void {
  const position = new Position(POSITION_FIXTURE.id)
  position.tokenId = POSITION_FIXTURE.tokenId
  position.owner = POSITION_FIXTURE.owner.toHexString()
  position.origin = POSITION_FIXTURE.origin.toHexString()
  position.createdAtTimestamp = MOCK_EVENT.block.timestamp
  initPositionState(position)
  position.save()
}

describe('handleModifyLiquidity', () => {
  beforeEach(() => {
    setUpPoolAndPrices()
  })

  afterEach(() => {
    clearStore()
  })

  test('success - add liquidity event, pool tick is between tickUpper and tickLower', () => {
    // put the pools tick in range
    const pool = Pool.load(USDC_WETH_POOL_ID)!
    pool.tick = BigInt.fromI32(MODIFY_LIQUIDITY_FIXTURE_ADD.tickLower + MODIFY_LIQUIDITY_FIXTURE_ADD.tickUpper).div(
      BigInt.fromI32(2),
    )
    pool.sqrtPrice = TickMath.getSqrtRatioAtTick(pool.tick!.toI32())
    pool.save()

    handleModifyLiquidityHelper(MODIFY_LIQUIDITY_EVENT_ADD, TEST_CONFIG)

    const amountToken0 = convertTokenToDecimal(
      BigInt.fromString('295530108791371696809'),
      BigInt.fromString(USDC_MAINNET_FIXTURE.decimals),
    )
    const amountToken1 = convertTokenToDecimal(
      BigInt.fromString('295530108791371696809'),
      BigInt.fromString(WETH_MAINNET_FIXTURE.decimals),
    )

    const poolTotalValueLockedETH = amountToken0
      .times(TEST_USDC_DERIVED_ETH)
      .plus(amountToken1.times(TEST_WETH_DERIVED_ETH))
    const poolTotalValueLockedUSD = poolTotalValueLockedETH.times(TEST_ETH_PRICE_USD)

    assertObjectMatches('PoolManager', TEST_CONFIG.poolManagerAddress, [
      ['txCount', '1'],
      ['totalValueLockedETH', poolTotalValueLockedETH.toString()],
      ['totalValueLockedUSD', poolTotalValueLockedUSD.toString()],
    ])

    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['txCount', '1'],
      ['liquidity', MODIFY_LIQUIDITY_FIXTURE_ADD.liquidityDelta.toString()],
      ['totalValueLockedToken0', amountToken0.toString()],
      ['totalValueLockedToken1', amountToken1.toString()],
      ['totalValueLockedETH', poolTotalValueLockedETH.toString()],
      ['totalValueLockedUSD', poolTotalValueLockedUSD.toString()],
    ])

    assertObjectMatches('Token', USDC_MAINNET_FIXTURE.address, [
      ['txCount', '1'],
      ['totalValueLocked', amountToken0.toString()],
      ['totalValueLockedUSD', amountToken0.times(TEST_USDC_DERIVED_ETH.times(TEST_ETH_PRICE_USD)).toString()],
    ])

    assertObjectMatches('Token', WETH_MAINNET_FIXTURE.address, [
      ['txCount', '1'],
      ['totalValueLocked', amountToken1.toString()],
      ['totalValueLockedUSD', amountToken1.times(TEST_WETH_DERIVED_ETH.times(TEST_ETH_PRICE_USD)).toString()],
    ])
    assertObjectMatches(
      'ModifyLiquidity',
      MOCK_EVENT.transaction.hash.toHexString() + '-' + MOCK_EVENT.logIndex.toString(),
      [
        ['transaction', MOCK_EVENT.transaction.hash.toHexString()],
        ['timestamp', MOCK_EVENT.block.timestamp.toString()],
        ['pool', USDC_WETH_POOL_ID],
        ['token0', USDC_MAINNET_FIXTURE.address],
        ['token1', WETH_MAINNET_FIXTURE.address],
        // ['owner', MODIFY_LIQUIDITY_FIXTURE.owner.toHexString()],
        ['sender', MODIFY_LIQUIDITY_FIXTURE_ADD.sender.toHexString()],
        ['origin', MOCK_EVENT.transaction.from.toHexString()],
        ['amount', MODIFY_LIQUIDITY_FIXTURE_ADD.liquidityDelta.toString()],
        ['amount0', amountToken0.toString()],
        ['amount1', amountToken1.toString()],
        ['amountUSD', poolTotalValueLockedUSD.toString()],
        // the pool's price at event time, which the amounts above were computed at
        ['sqrtPrice', pool.sqrtPrice.toString()],
        ['tick', pool.tick!.toString()],
        ['tickUpper', MODIFY_LIQUIDITY_FIXTURE_ADD.tickUpper.toString()],
        ['tickLower', MODIFY_LIQUIDITY_FIXTURE_ADD.tickLower.toString()],
        ['logIndex', MOCK_EVENT.logIndex.toString()],
      ],
    )

    const lowerTickPrice = fastExponentiation(BigDecimal.fromString('1.0001'), MODIFY_LIQUIDITY_FIXTURE_ADD.tickLower)
    assertObjectMatches('Tick', USDC_WETH_POOL_ID + '#' + MODIFY_LIQUIDITY_FIXTURE_ADD.tickLower.toString(), [
      ['tickIdx', MODIFY_LIQUIDITY_FIXTURE_ADD.tickLower.toString()],
      ['pool', USDC_WETH_POOL_ID],
      ['poolAddress', USDC_WETH_POOL_ID],
      ['createdAtTimestamp', MOCK_EVENT.block.timestamp.toString()],
      ['createdAtBlockNumber', MOCK_EVENT.block.number.toString()],
      ['liquidityGross', MODIFY_LIQUIDITY_FIXTURE_ADD.liquidityDelta.toString()],
      ['liquidityNet', MODIFY_LIQUIDITY_FIXTURE_ADD.liquidityDelta.toString()],
      ['price0', lowerTickPrice.toString()],
      ['price1', safeDiv(ONE_BD, lowerTickPrice).toString()],
    ])

    const upperTickPrice = fastExponentiation(BigDecimal.fromString('1.0001'), MODIFY_LIQUIDITY_FIXTURE_ADD.tickUpper)
    assertObjectMatches('Tick', USDC_WETH_POOL_ID + '#' + MODIFY_LIQUIDITY_FIXTURE_ADD.tickUpper.toString(), [
      ['tickIdx', MODIFY_LIQUIDITY_FIXTURE_ADD.tickUpper.toString()],
      ['pool', USDC_WETH_POOL_ID],
      ['poolAddress', USDC_WETH_POOL_ID],
      ['createdAtTimestamp', MOCK_EVENT.block.timestamp.toString()],
      ['createdAtBlockNumber', MOCK_EVENT.block.number.toString()],
      ['liquidityGross', MODIFY_LIQUIDITY_FIXTURE_ADD.liquidityDelta.toString()],
      ['liquidityNet', MODIFY_LIQUIDITY_FIXTURE_ADD.liquidityDelta.neg().toString()],
      ['price0', upperTickPrice.toString()],
      ['price1', safeDiv(ONE_BD, upperTickPrice).toString()],
    ])
  })

  test('success - remove liquidity event, pool tick is between tickUpper and tickLower', () => {
    // put the pools tick in range
    const pool = Pool.load(USDC_WETH_POOL_ID)!
    pool.tick = BigInt.fromI32(
      MODIFY_LIQUIDITY_FIXTURE_REMOVE.tickLower + MODIFY_LIQUIDITY_FIXTURE_REMOVE.tickUpper,
    ).div(BigInt.fromI32(2))
    pool.sqrtPrice = TickMath.getSqrtRatioAtTick(pool.tick!.toI32())
    pool.save()

    handleModifyLiquidityHelper(MODIFY_LIQUIDITY_EVENT_REMOVE, TEST_CONFIG)

    const amountToken0 = convertTokenToDecimal(
      BigInt.fromString('-295530108791371696808'),
      BigInt.fromString(USDC_MAINNET_FIXTURE.decimals),
    )
    const amountToken1 = convertTokenToDecimal(
      BigInt.fromString('-295530108791371696808'),
      BigInt.fromString(WETH_MAINNET_FIXTURE.decimals),
    )
    const poolTotalValueLockedETH = amountToken0
      .times(TEST_USDC_DERIVED_ETH)
      .plus(amountToken1.times(TEST_WETH_DERIVED_ETH))
    const poolTotalValueLockedUSD = poolTotalValueLockedETH.times(TEST_ETH_PRICE_USD)

    assertObjectMatches('PoolManager', TEST_CONFIG.poolManagerAddress, [
      ['txCount', '1'],
      ['totalValueLockedETH', poolTotalValueLockedETH.toString()],
      ['totalValueLockedUSD', poolTotalValueLockedUSD.toString()],
    ])

    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [
      ['txCount', '1'],
      ['liquidity', MODIFY_LIQUIDITY_FIXTURE_REMOVE.liquidityDelta.toString()],
      ['totalValueLockedToken0', amountToken0.toString()],
      ['totalValueLockedToken1', amountToken1.toString()],
      ['totalValueLockedETH', poolTotalValueLockedETH.toString()],
      ['totalValueLockedUSD', poolTotalValueLockedUSD.toString()],
    ])

    assertObjectMatches('Token', USDC_MAINNET_FIXTURE.address, [
      ['txCount', '1'],
      ['totalValueLocked', amountToken0.toString()],
      ['totalValueLockedUSD', amountToken0.times(TEST_USDC_DERIVED_ETH.times(TEST_ETH_PRICE_USD)).toString()],
    ])

    assertObjectMatches('Token', WETH_MAINNET_FIXTURE.address, [
      ['txCount', '1'],
      ['totalValueLocked', amountToken1.toString()],
      ['totalValueLockedUSD', amountToken1.times(TEST_WETH_DERIVED_ETH.times(TEST_ETH_PRICE_USD)).toString()],
    ])
    assertObjectMatches(
      'ModifyLiquidity',
      MOCK_EVENT.transaction.hash.toHexString() + '-' + MOCK_EVENT.logIndex.toString(),
      [
        ['transaction', MOCK_EVENT.transaction.hash.toHexString()],
        ['timestamp', MOCK_EVENT.block.timestamp.toString()],
        ['pool', USDC_WETH_POOL_ID],
        ['token0', USDC_MAINNET_FIXTURE.address],
        ['token1', WETH_MAINNET_FIXTURE.address],
        ['sender', MODIFY_LIQUIDITY_FIXTURE_REMOVE.sender.toHexString()],
        ['origin', MOCK_EVENT.transaction.from.toHexString()],
        ['amount', MODIFY_LIQUIDITY_FIXTURE_REMOVE.liquidityDelta.toString()],
        ['amount0', amountToken0.toString()],
        ['amount1', amountToken1.toString()],
        ['amountUSD', poolTotalValueLockedUSD.toString()],
        ['tickUpper', MODIFY_LIQUIDITY_FIXTURE_REMOVE.tickUpper.toString()],
        ['tickLower', MODIFY_LIQUIDITY_FIXTURE_REMOVE.tickLower.toString()],
        ['logIndex', MOCK_EVENT.logIndex.toString()],
      ],
    )

    const lowerTickPrice = fastExponentiation(
      BigDecimal.fromString('1.0001'),
      MODIFY_LIQUIDITY_FIXTURE_REMOVE.tickLower,
    )
    assertObjectMatches('Tick', USDC_WETH_POOL_ID + '#' + MODIFY_LIQUIDITY_FIXTURE_REMOVE.tickLower.toString(), [
      ['tickIdx', MODIFY_LIQUIDITY_FIXTURE_REMOVE.tickLower.toString()],
      ['pool', USDC_WETH_POOL_ID],
      ['poolAddress', USDC_WETH_POOL_ID],
      ['createdAtTimestamp', MOCK_EVENT.block.timestamp.toString()],
      ['createdAtBlockNumber', MOCK_EVENT.block.number.toString()],
      ['liquidityGross', MODIFY_LIQUIDITY_FIXTURE_REMOVE.liquidityDelta.toString()],
      ['liquidityNet', MODIFY_LIQUIDITY_FIXTURE_REMOVE.liquidityDelta.toString()],
      ['price0', lowerTickPrice.toString()],
      ['price1', safeDiv(ONE_BD, lowerTickPrice).toString()],
    ])

    const upperTickPrice = fastExponentiation(
      BigDecimal.fromString('1.0001'),
      MODIFY_LIQUIDITY_FIXTURE_REMOVE.tickUpper,
    )
    assertObjectMatches('Tick', USDC_WETH_POOL_ID + '#' + MODIFY_LIQUIDITY_FIXTURE_REMOVE.tickUpper.toString(), [
      ['tickIdx', MODIFY_LIQUIDITY_FIXTURE_REMOVE.tickUpper.toString()],
      ['pool', USDC_WETH_POOL_ID],
      ['poolAddress', USDC_WETH_POOL_ID],
      ['createdAtTimestamp', MOCK_EVENT.block.timestamp.toString()],
      ['createdAtBlockNumber', MOCK_EVENT.block.number.toString()],
      ['liquidityGross', MODIFY_LIQUIDITY_FIXTURE_REMOVE.liquidityDelta.toString()],
      ['liquidityNet', MODIFY_LIQUIDITY_FIXTURE_REMOVE.liquidityDelta.neg().toString()],
      ['price0', upperTickPrice.toString()],
      ['price1', safeDiv(ONE_BD, upperTickPrice).toString()],
    ])
  })

  test('success - add liquidity event, pool tick is not between tickUpper and tickLower', () => {
    // put the pools tick out of range
    const pool = Pool.load(USDC_WETH_POOL_ID)!
    pool.tick = BigInt.fromI32(MODIFY_LIQUIDITY_FIXTURE_ADD.tickLower - 1)
    const liquidityBeforeModifyLiquidity = pool.liquidity
    pool.save()

    handleModifyLiquidityHelper(MODIFY_LIQUIDITY_EVENT_ADD, TEST_CONFIG)

    // liquidity should not be updated
    assertObjectMatches('Pool', USDC_WETH_POOL_ID, [['liquidity', liquidityBeforeModifyLiquidity.toString()]])
  })

  test('success - amounts are correct for remove liquidity event with currentTick just under upper tick', () => {
    const FIXTURE: ModifyLiquidityFixture = {
      id: USDC_WETH_POOL_ID,
      sender: Address.fromString('0x39BF2eFF94201cfAA471932655404F63315147a4'),
      tickLower: 16080,
      tickUpper: 21180,
      liquidityDelta: BigInt.fromString('-171307279129958064896084173'),
    }

    const event = new ModifyLiquidity(
      MOCK_EVENT.address,
      MOCK_EVENT.logIndex,
      MOCK_EVENT.transactionLogIndex,
      MOCK_EVENT.logType,
      MOCK_EVENT.block,
      MOCK_EVENT.transaction,
      [
        new ethereum.EventParam('id', ethereum.Value.fromFixedBytes(id)),
        new ethereum.EventParam('sender', ethereum.Value.fromAddress(FIXTURE.sender)),
        new ethereum.EventParam('tickLower', ethereum.Value.fromI32(FIXTURE.tickLower)),
        new ethereum.EventParam('tickUpper', ethereum.Value.fromI32(FIXTURE.tickUpper)),
        new ethereum.EventParam('liquidityDelta', ethereum.Value.fromSignedBigInt(FIXTURE.liquidityDelta)),
      ],
      MOCK_EVENT.receipt,
    )

    const pool = Pool.load(USDC_WETH_POOL_ID)!
    pool.tick = BigInt.fromI32(21179)
    pool.sqrtPrice = BigInt.fromString('228441206771431211303324095474')
    pool.save()

    handleModifyLiquidityHelper(event, TEST_CONFIG)

    const expectedAmount0 = BigDecimal.fromString('-0.000000002367391256')
    const expectedAmount1 = BigDecimal.fromString('-111171964.475622427888514086')
    assertObjectMatches(
      'ModifyLiquidity',
      MOCK_EVENT.transaction.hash.toHexString() + '-' + MOCK_EVENT.logIndex.toString(),
      [
        ['amount0', expectedAmount0.toString()],
        ['amount1', expectedAmount1.toString()],
      ],
    )
  })

  test('liquidity events snapshot period state but never write a candle', () => {
    // put the pools tick in range so the add moves pool.liquidity
    const pool = Pool.load(USDC_WETH_POOL_ID)!
    pool.tick = BigInt.fromI32(MODIFY_LIQUIDITY_FIXTURE_ADD.tickLower + MODIFY_LIQUIDITY_FIXTURE_ADD.tickUpper).div(
      BigInt.fromI32(2),
    )
    pool.sqrtPrice = TickMath.getSqrtRatioAtTick(pool.tick!.toI32())
    pool.save()

    handleModifyLiquidityHelper(MODIFY_LIQUIDITY_EVENT_ADD, TEST_CONFIG)

    const hourId = MOCK_EVENT.block.timestamp.toI32() / 3600
    const hourEntity = USDC_WETH_POOL_ID + '-' + hourId.toString()

    // The state snapshot reflects THIS event (in-range add moved pool.liquidity)...
    assert.fieldEquals('PoolHourData', hourEntity, 'liquidity', MODIFY_LIQUIDITY_FIXTURE_ADD.liquidityDelta.toString())
    // ...but the bucket has no candle: neither pool init nor a liquidity event
    // is a swap, and a rendered candle must imply real trading.
    const hourData = PoolHourData.load(hourEntity)!
    assert.assertTrue(hourData.open === null)
    assert.assertTrue(hourData.high === null)
    assert.assertTrue(hourData.low === null)
    assert.assertTrue(hourData.close === null)
    assert.assertTrue(hourData.closeOrdinal === null)
  })
})

describe('handleModifyLiquidity records Position state', () => {
  beforeEach(() => {
    setUpPoolAndPrices()
  })

  afterEach(() => {
    clearStore()
  })

  test('mint: pool, range, entry price, deposit and snapshot #1', () => {
    storePosition()
    const pool = putPoolInRange()

    handleModifyLiquidityHelper(positionManagerModifyEvent(ADD_DELTA), TEST_CONFIG, POSITION_MANAGER)

    assertObjectMatches('ModifyLiquidity', MODIFY_LIQUIDITY_ID, [['position', POSITION_FIXTURE.id]])
    assertObjectMatches('Position', POSITION_FIXTURE.id, [
      ['pool', USDC_WETH_POOL_ID],
      ['tickLower', MODIFY_LIQUIDITY_FIXTURE_ADD.tickLower.toString()],
      ['tickUpper', MODIFY_LIQUIDITY_FIXTURE_ADD.tickUpper.toString()],
      ['mintSqrtPrice', pool.sqrtPrice.toString()],
      ['mintTick', pool.tick!.toString()],
      ['liquidity', ADD_DELTA.toString()],
      ['modifyCount', '1'],
      ['depositedToken0', ADD_AMOUNT0.toString()],
      ['depositedToken1', ADD_AMOUNT1.toString()],
      ['withdrawnToken0', '0'],
      ['withdrawnToken1', '0'],
      ['depositedUSD', ADD_USD.toString()],
      ['depositedETH', ADD_ETH.toString()],
      ['withdrawnUSD', '0'],
      ['withdrawnETH', '0'],
      ['lastModifiedTimestamp', MOCK_EVENT.block.timestamp.toString()],
    ])
    assert.assertTrue(Position.load(POSITION_FIXTURE.id)!.closedAtTimestamp === null)

    assertObjectMatches('PositionSnapshot', POSITION_FIXTURE.id + '#1', [
      ['position', POSITION_FIXTURE.id],
      ['pool', USDC_WETH_POOL_ID],
      ['owner', POSITION_FIXTURE.owner.toHexString()],
      ['transaction', MOCK_EVENT.transaction.hash.toHexString()],
      ['modifyLiquidity', MODIFY_LIQUIDITY_ID],
      ['timestamp', MOCK_EVENT.block.timestamp.toString()],
      ['blockNumber', MOCK_EVENT.block.number.toString()],
      ['logIndex', MOCK_EVENT.logIndex.toString()],
      ['liquidityDelta', ADD_DELTA.toString()],
      ['liquidity', ADD_DELTA.toString()],
      ['amount0', ADD_AMOUNT0.toString()],
      ['amount1', ADD_AMOUNT1.toString()],
      ['amountUSD', ADD_USD.toString()],
      ['amountETH', ADD_ETH.toString()],
      ['depositedToken0', ADD_AMOUNT0.toString()],
      ['withdrawnToken0', '0'],
      ['depositedUSD', ADD_USD.toString()],
      ['withdrawnUSD', '0'],
      ['sqrtPrice', pool.sqrtPrice.toString()],
      ['tick', pool.tick!.toString()],
      ['ethPriceUSD', TEST_ETH_PRICE_USD.toString()],
      ['token0DerivedETH', TEST_USDC_DERIVED_ETH.toString()],
      ['token1DerivedETH', TEST_WETH_DERIVED_ETH.toString()],
    ])
  })

  test('removing everything closes the position; adding again reopens it', () => {
    storePosition()
    putPoolInRange()

    handleModifyLiquidityHelper(positionManagerModifyEvent(ADD_DELTA), TEST_CONFIG, POSITION_MANAGER)
    handleModifyLiquidityHelper(positionManagerModifyEvent(REMOVE_DELTA), TEST_CONFIG, POSITION_MANAGER)

    assertObjectMatches('Position', POSITION_FIXTURE.id, [
      ['liquidity', '0'],
      ['modifyCount', '2'],
      ['depositedToken0', ADD_AMOUNT0.toString()],
      ['withdrawnToken0', REMOVE_AMOUNT0.neg().toString()],
      ['withdrawnToken1', REMOVE_AMOUNT1.neg().toString()],
      ['withdrawnUSD', REMOVE_USD.neg().toString()],
      ['withdrawnETH', REMOVE_ETH.neg().toString()],
      ['closedAtTimestamp', MOCK_EVENT.block.timestamp.toString()],
    ])
    assertObjectMatches('PositionSnapshot', POSITION_FIXTURE.id + '#2', [
      ['liquidityDelta', REMOVE_DELTA.toString()],
      ['liquidity', '0'],
      ['amount0', REMOVE_AMOUNT0.toString()],
      ['amountUSD', REMOVE_USD.toString()],
      ['depositedToken0', ADD_AMOUNT0.toString()],
      ['withdrawnToken0', REMOVE_AMOUNT0.neg().toString()],
    ])

    handleModifyLiquidityHelper(positionManagerModifyEvent(ADD_DELTA), TEST_CONFIG, POSITION_MANAGER)

    assertObjectMatches('Position', POSITION_FIXTURE.id, [
      ['liquidity', ADD_DELTA.toString()],
      ['modifyCount', '3'],
      ['depositedToken0', ADD_AMOUNT0.plus(ADD_AMOUNT0).toString()],
      ['depositedUSD', ADD_USD.plus(ADD_USD).toString()],
      // the range and entry price stay the mint's
      ['mintSqrtPrice', Pool.load(USDC_WETH_POOL_ID)!.sqrtPrice.toString()],
    ])
    assert.assertTrue(Position.load(POSITION_FIXTURE.id)!.closedAtTimestamp === null)
    assert.entityCount('PositionSnapshot', 3)
  })

  test('a modify from any other sender leaves the position untouched and writes no snapshot', () => {
    storePosition()
    putPoolInRange()

    handleModifyLiquidityHelper(MODIFY_LIQUIDITY_EVENT_ADD, TEST_CONFIG, POSITION_MANAGER)

    assert.entityCount('PositionSnapshot', 0)
    assertObjectMatches('Position', POSITION_FIXTURE.id, [
      ['liquidity', '0'],
      ['modifyCount', '0'],
    ])
    assert.assertTrue(Position.load(POSITION_FIXTURE.id)!.pool === null)
    assert.assertTrue(ModifyLiquidityEntity.load(MODIFY_LIQUIDITY_ID)!.position === null)
  })

  test('a PositionManager modify for an unknown tokenId is recorded without a position', () => {
    putPoolInRange()

    handleModifyLiquidityHelper(positionManagerModifyEvent(ADD_DELTA), TEST_CONFIG, POSITION_MANAGER)

    assert.entityCount('PositionSnapshot', 0)
    assert.entityCount('Position', 0)
    assert.assertTrue(ModifyLiquidityEntity.load(MODIFY_LIQUIDITY_ID)!.position === null)
  })
})
