import { PoolInitialized as AscntInitializedEvent } from '../types/SimHookMVPLegacy/SimHookMVPLegacy'
import { getSubgraphConfig, SubgraphConfig } from '../utils/chains'
import { ascntInitializedCore } from './ascntCore'

export function handleAscntInitialized(event: AscntInitializedEvent): void {
  handleAscntInitializedHelper(event)
}

export function handleAscntInitializedHelper(
  event: AscntInitializedEvent,
  subgraphConfig: SubgraphConfig = getSubgraphConfig(),
): void {
  ascntInitializedCore(event.params.id.toHexString(), subgraphConfig)
}
