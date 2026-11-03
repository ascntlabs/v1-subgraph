import { Address, BigInt, Bytes, ethereum } from '@graphprotocol/graph-ts'
import { assert, beforeEach, clearStore, createMockedFunction, describe, test } from 'matchstick-as'

import { handleHookDeployed } from '../../src/mappings/hookFactory'
import { HookDeployed } from '../../src/types/HookFactory/HookFactory'
import { Hook, Protocol } from '../../src/types/schema'
import { loadOrCreateHook } from '../../src/utils/hookEntity'
import { MOCK_EVENT } from './constants'

const FACTORY = '0x00000000000000000000000000000000000000f0'
const GOVERNANCE = '0x00000000000000000000000000000000000000e0'
const HOOK = '0x00000000000000000000000000000000000000a0'
const SALT = '0x1111111111111111111111111111111111111111111111111111111111111111'

function createHookDeployedEvent(): HookDeployed {
  return new HookDeployed(
    Address.fromString(FACTORY),
    MOCK_EVENT.logIndex,
    MOCK_EVENT.transactionLogIndex,
    MOCK_EVENT.logType,
    MOCK_EVENT.block,
    MOCK_EVENT.transaction,
    [
      new ethereum.EventParam('hook', ethereum.Value.fromAddress(Address.fromString(HOOK))),
      new ethereum.EventParam('salt', ethereum.Value.fromFixedBytes(Bytes.fromHexString(SALT))),
    ],
    MOCK_EVENT.receipt,
  )
}

function mockFactoryGovernance(): void {
  createMockedFunction(Address.fromString(FACTORY), 'governance', 'governance():(address)').returns([
    ethereum.Value.fromAddress(Address.fromString(GOVERNANCE)),
  ])
}

function storeProtocol(bps: i32): void {
  const protocol = new Protocol(GOVERNANCE)
  protocol.protocolFeeBps = BigInt.fromI32(bps)
  protocol.addLiquidityPaused = false
  protocol.save()
}

describe('handleHookDeployed', () => {
  beforeEach(() => {
    clearStore()
  })

  test('seeds cachedProtocolFeeBps with the governance bps the constructor copies', () => {
    storeProtocol(1500)
    mockFactoryGovernance()

    handleHookDeployed(createHookDeployedEvent())

    assert.fieldEquals('Hook', HOOK, 'cachedProtocolFeeBps', '1500')
    assert.fieldEquals('Hook', HOOK, 'factory', FACTORY)
    assert.fieldEquals('Hook', HOOK, 'salt', SALT)
    assert.fieldEquals('Hook', HOOK, 'deprecated', 'false')
    assert.fieldEquals('Hook', HOOK, 'legacy', 'false')
    assert.dataSourceCount('SimHook', 1)
  })

  test('seeds 0 when governance has never set a fee', () => {
    mockFactoryGovernance()

    handleHookDeployed(createHookDeployedEvent())

    assert.fieldEquals('Hook', HOOK, 'cachedProtocolFeeBps', '0')
  })

  test('leaves cachedProtocolFeeBps null when the factory call reverts', () => {
    storeProtocol(1500)
    createMockedFunction(Address.fromString(FACTORY), 'governance', 'governance():(address)').reverts()

    handleHookDeployed(createHookDeployedEvent())

    const hook = Hook.load(HOOK)!
    assert.assertTrue(hook.cachedProtocolFeeBps === null)
  })

  test('keeps a value already pushed by ProtocolFeeBpsCached', () => {
    storeProtocol(1500)
    mockFactoryGovernance()
    const existing = loadOrCreateHook(Address.fromString(HOOK), MOCK_EVENT)
    existing.cachedProtocolFeeBps = BigInt.fromI32(700)
    existing.save()

    handleHookDeployed(createHookDeployedEvent())

    assert.fieldEquals('Hook', HOOK, 'cachedProtocolFeeBps', '700')
  })
})
