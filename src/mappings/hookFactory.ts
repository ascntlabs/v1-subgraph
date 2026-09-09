import { HookDeployed, HookDeprecationChanged } from '../types/HookFactory/HookFactory'
import { SimHook as SimHookTemplate } from '../types/templates'
import { loadOrCreateHook } from '../utils/hookEntity'

export function handleHookDeployed(event: HookDeployed): void {
  const hook = loadOrCreateHook(event.params.hook, event)
  hook.salt = event.params.salt
  hook.factory = event.address
  hook.createdAtTimestamp = event.block.timestamp
  hook.createdAtBlockNumber = event.block.number
  hook.save()

  // start indexing the newly deployed hook's events
  SimHookTemplate.create(event.params.hook)
}

export function handleHookDeprecationChanged(event: HookDeprecationChanged): void {
  const hook = loadOrCreateHook(event.params.hook, event)
  hook.deprecated = event.params.deprecated
  hook.save()
}
