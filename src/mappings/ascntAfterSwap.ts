import { AfterSwap as AscntAfterSwapEvent } from '../types/SimHookMVPLegacy/SimHookMVPLegacy'
import { ascntAfterSwapCore } from './ascntCore'

export { priceImpactRelativeErrorWad } from './ascntCore'

export function handleAscntAfterSwap(event: AscntAfterSwapEvent): void {
  handleAscntAfterSwapHelper(event)
}

export function handleAscntAfterSwapHelper(event: AscntAfterSwapEvent): void {
  ascntAfterSwapCore(event, event.params.poolId.toHexString(), event.params.priceImpact, event.params.cumPriceImpact)
}
