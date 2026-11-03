import { Address, Bytes, ethereum } from '@graphprotocol/graph-ts'

import { Hook } from '../types/schema'
import { ADDRESS_ZERO, ZERO_BI } from './constants'

// Hooks are normally created by handleHookDeployed with real salt/factory data.
// The load-or-create fallback covers hooks referenced by governance or fee
// events before (or without) a HookDeployed event — those keep zeroed
// provenance fields.
export function loadOrCreateHook(address: Address, event: ethereum.Event): Hook {
  const id = address.toHexString()
  let hook = Hook.load(id)

  if (hook === null) {
    hook = new Hook(id)
    hook.salt = Bytes.empty()
    hook.factory = Bytes.fromHexString(ADDRESS_ZERO)
    hook.createdAtTimestamp = event.block.timestamp
    hook.createdAtBlockNumber = event.block.number
    hook.deprecated = false
    hook.legacy = false
    hook.addLiquidityPaused = false
    hook.isSubscriber = false
    hook.subscriberPushFailCount = ZERO_BI
    hook.save()
  }

  return hook
}

// Pre-factory hooks (SubgraphConfig.legacyHookAddresses) never emitted
// HookDeployed, so their entity is created at the first Initialize on them:
// zeroed provenance, deprecated from the start, legacy. Idempotent.
export function loadOrCreateLegacyHook(address: Address, event: ethereum.Event): Hook {
  const hook = loadOrCreateHook(address, event)
  if (!hook.legacy) {
    hook.deprecated = true
    hook.legacy = true
    hook.save()
  }
  return hook
}
