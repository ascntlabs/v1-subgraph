import { BigInt, log } from '@graphprotocol/graph-ts'

import { Pool } from '../types/schema'
import { PoolConfigured as AscntConfiguredEvent } from '../types/SimHookMVPLegacy/SimHookMVPLegacy'

export function handleAscntConfigured(event: AscntConfiguredEvent): void {
  handleAscntConfiguredHelper(event)
}

export function handleAscntConfiguredHelper(event: AscntConfiguredEvent): void {
  const poolId = event.params.poolId.toHexString()
  const pool = Pool.load(poolId)

  if (!pool) {
    log.warning('Pool not found: {}', [poolId])
    return
  }

  pool.configured = event.params.configured
  // SimHookMVP's min fee is a range; surface the lower bound as the pool's minFee.
  pool.minFee = BigInt.fromI32(event.params.minMinFee)
  pool.maxFee = BigInt.fromI32(event.params.maxFee)
  pool.fallbackFee = BigInt.fromI32(event.params.fallbackFee)
  pool.timeDecayLength = event.params.timeDecayLength

  pool.save()
}
