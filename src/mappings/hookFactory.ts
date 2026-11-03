import { Address, log } from '@graphprotocol/graph-ts'

import { HookDeployed, HookDeprecationChanged, HookFactory } from '../types/HookFactory/HookFactory'
import { Hook, Protocol } from '../types/schema'
import { SimHook as SimHookTemplate } from '../types/templates'
import { ZERO_BI } from '../utils/constants'
import { loadOrCreateHook } from '../utils/hookEntity'

// AscntBaseHook's constructor copies governance.protocolFeeBps() into its own
// protocolFeeBps without emitting ProtocolFeeBpsCached, so a hook deployed while
// governance already charges a fee would read as null until the next push.
// Mirror the constructor: ask the factory which governance it wires in and copy
// that Protocol's current bps. No Protocol entity means no fee was ever set, so
// the constructor read 0 too.
export function seedCachedProtocolFeeBps(hook: Hook, factory: Address): void {
  if (hook.cachedProtocolFeeBps !== null) {
    // a real ProtocolFeeBpsCached already landed; never overwrite it
    return
  }
  const governance = HookFactory.bind(factory).try_governance()
  if (governance.reverted) {
    log.warning('handleHookDeployed: governance() reverted on factory {}, cachedProtocolFeeBps left null', [
      factory.toHexString(),
    ])
    return
  }
  const protocol = Protocol.load(governance.value.toHexString())
  hook.cachedProtocolFeeBps = protocol === null ? ZERO_BI : protocol.protocolFeeBps
}

export function handleHookDeployed(event: HookDeployed): void {
  const hook = loadOrCreateHook(event.params.hook, event)
  hook.salt = event.params.salt
  hook.factory = event.address
  hook.createdAtTimestamp = event.block.timestamp
  hook.createdAtBlockNumber = event.block.number
  seedCachedProtocolFeeBps(hook, event.address)
  hook.save()

  // start indexing the newly deployed hook's events
  SimHookTemplate.create(event.params.hook)
}

export function handleHookDeprecationChanged(event: HookDeprecationChanged): void {
  const hook = loadOrCreateHook(event.params.hook, event)
  hook.deprecated = event.params.deprecated
  hook.save()
}
