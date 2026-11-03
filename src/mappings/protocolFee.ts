import { log } from '@graphprotocol/graph-ts'

import { ProtocolFeeUpdated as ProtocolFeeUpdatedEvent } from '../types/PoolManager/PoolManager'
import { Pool } from '../types/schema'
import { protocolFeeOneForZero, protocolFeeZeroForOne } from '../utils/fees'

// PoolManager.setProtocolFee (fee-controller only). The rate is packed per swap
// direction; handleSwap reads the input side's rate to split Swap.fee into the
// LP and protocol shares. v4-core initialises pools at 0, so a pool that never
// sees this event has Swap.fee == its LP fee.
export function handleProtocolFeeUpdated(event: ProtocolFeeUpdatedEvent): void {
  const poolId = event.params.id.toHexString()
  const pool = Pool.load(poolId)
  if (pool === null) {
    log.debug('handleProtocolFeeUpdated: pool not found {}', [poolId])
    return
  }

  pool.uniswapProtocolFeeZeroForOne = protocolFeeZeroForOne(event.params.protocolFee)
  pool.uniswapProtocolFeeOneForZero = protocolFeeOneForZero(event.params.protocolFee)
  pool.save()
}
