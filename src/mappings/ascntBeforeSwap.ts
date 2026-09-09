import { BigInt } from '@graphprotocol/graph-ts'

import { BeforeSwap as AscntBeforeSwapEvent } from '../types/SimHookMVPLegacy/SimHookMVPLegacy'
import { ascntBeforeSwapCore } from './ascntCore'

export function handleAscntBeforeSwap(event: AscntBeforeSwapEvent): void {
  handleAscntBeforeSwapHelper(event)
}

export function handleAscntBeforeSwapHelper(event: AscntBeforeSwapEvent): void {
  ascntBeforeSwapCore(
    event,
    event.params.poolId.toHexString(),
    event.params.sqrtPriceX96Before,
    event.params.priceImpact,
    event.params.decayedCumPriceImpact,
    BigInt.fromI32(event.params.dynamicFeePips),
  )
}
