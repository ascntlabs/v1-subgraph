import { Address, BigInt } from '@graphprotocol/graph-ts'

import {
  AddLiquidityPauseSet,
  HookAddLiquidityPauseSet,
  HookFactoryUpdated,
  OwnershipTransferred,
  PauserUpdated,
  PoolDeployerUpdated,
  ProtocolFeeBpsUpdated,
  SubscriberPushFailed,
  SubscriberRegistered,
  SubscriberRemoved,
  TimelockTransferCancelled,
  TimelockTransferStarted,
  TimelockUpdated,
  TreasuryUpdated,
} from '../types/AscntGovernance/AscntGovernance'
import { Pool, PoolManager, Protocol } from '../types/schema'
import { getSubgraphConfig, SubgraphConfig } from '../utils/chains'
import { ONE_BI, ZERO_BI } from '../utils/constants'
import { loadOrCreateHook } from '../utils/hookEntity'

function loadProtocol(governance: Address): Protocol {
  const id = governance.toHexString()
  let protocol = Protocol.load(id)

  if (protocol === null) {
    protocol = new Protocol(id)
    protocol.protocolFeeBps = ZERO_BI
    protocol.addLiquidityPaused = false
  }

  return protocol
}

export function handleTreasuryUpdated(event: TreasuryUpdated): void {
  const protocol = loadProtocol(event.address)
  protocol.treasury = event.params.treasury
  protocol.save()
}

export function handleProtocolFeeBpsUpdated(event: ProtocolFeeBpsUpdated): void {
  const protocol = loadProtocol(event.address)
  protocol.protocolFeeBps = BigInt.fromI32(event.params.bps)
  protocol.save()
}

export function handleAddLiquidityPauseSet(event: AddLiquidityPauseSet): void {
  const protocol = loadProtocol(event.address)
  protocol.addLiquidityPaused = event.params.paused
  protocol.save()
}

export function handleHookAddLiquidityPauseSet(event: HookAddLiquidityPauseSet): void {
  const hook = loadOrCreateHook(event.params.hook, event)
  hook.addLiquidityPaused = event.params.paused
  hook.save()
}

export function handlePauserUpdated(event: PauserUpdated): void {
  const protocol = loadProtocol(event.address)
  protocol.pauser = event.params.pauser
  protocol.save()
}

export function handleTimelockUpdated(event: TimelockUpdated): void {
  const protocol = loadProtocol(event.address)
  protocol.timelock = event.params.timelock
  protocol.pendingTimelock = null
  protocol.pendingTimelockExpiry = null
  protocol.save()
}

export function handleTimelockTransferStarted(event: TimelockTransferStarted): void {
  const protocol = loadProtocol(event.address)
  protocol.pendingTimelock = event.params.pendingTimelock
  protocol.pendingTimelockExpiry = event.params.expiry
  protocol.save()
}

export function handleTimelockTransferCancelled(event: TimelockTransferCancelled): void {
  const protocol = loadProtocol(event.address)
  protocol.pendingTimelock = null
  protocol.pendingTimelockExpiry = null
  protocol.save()
}

export function handlePoolDeployerUpdated(event: PoolDeployerUpdated): void {
  const protocol = loadProtocol(event.address)
  protocol.poolDeployer = event.params.poolDeployer
  protocol.save()
}

export function handleHookFactoryUpdated(event: HookFactoryUpdated): void {
  const protocol = loadProtocol(event.address)
  protocol.hookFactory = event.params.factory
  protocol.save()
}

export function handleSubscriberRegistered(event: SubscriberRegistered): void {
  const hook = loadOrCreateHook(event.params.hook, event)
  hook.isSubscriber = true
  hook.save()
}

export function handleSubscriberRemoved(event: SubscriberRemoved): void {
  handleSubscriberRemovedHelper(event)
}

// Removal is one-way on-chain (only the factory registers, and only inside
// deployHook), and it decommissions the hook: protocol fee pushed to zero and
// add-liquidity force-paused. So the hook's pools stop being Ascnt pools for
// good: clear the flag, drop them from PoolManager.ascntPools, and the swap
// overlay stops accruing (ascntCore gates on isAscntPool). Uniswap-level swap
// and liquidity data for the pool keeps indexing as usual.
export function handleSubscriberRemovedHelper(
  event: SubscriberRemoved,
  subgraphConfig: SubgraphConfig = getSubgraphConfig(),
): void {
  const hook = loadOrCreateHook(event.params.hook, event)
  hook.isSubscriber = false
  hook.subscriberRemovedAtBlock = event.block.number
  hook.subscriberRemovedAtTimestamp = event.block.timestamp
  hook.save()

  const poolManager = PoolManager.load(subgraphConfig.poolManagerAddress)
  if (poolManager === null) {
    return
  }

  const ascntPools = poolManager.ascntPools
  const remaining: string[] = []
  let removed = 0
  for (let i = 0; i < ascntPools.length; i++) {
    const pool = Pool.load(ascntPools[i])
    if (pool === null || pool.hooks != hook.id) {
      remaining.push(ascntPools[i])
      continue
    }
    pool.isAscntPool = false
    pool.ascntRemovedAtBlock = event.block.number
    pool.ascntRemovedAtTimestamp = event.block.timestamp
    pool.save()
    removed++
  }

  if (removed > 0) {
    poolManager.ascntPools = remaining
    poolManager.ascntPoolCount = poolManager.ascntPoolCount.minus(BigInt.fromI32(removed))
    poolManager.save()
  }
}

export function handleSubscriberPushFailed(event: SubscriberPushFailed): void {
  const hook = loadOrCreateHook(event.params.hook, event)
  hook.subscriberPushFailCount = hook.subscriberPushFailCount.plus(ONE_BI)
  hook.save()
}

export function handleOwnershipTransferred(event: OwnershipTransferred): void {
  const protocol = loadProtocol(event.address)
  protocol.owner = event.params.newOwner
  protocol.save()
}
