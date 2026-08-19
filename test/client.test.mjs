// Client-half smoke test: the bundle registers with the ModuleLoader, the
// factory exposes the expected contract, the dictionaries stay zh/en
// balanced (the host rejects unbalanced registrations), and the section
// registers into settings.section with a thunk label.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => { captured = definition },
  },
}

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const code = readFileSync(clientPath, 'utf8')

await import(clientPath + '?smoke=' + Date.now())

assert.ok(captured, 'client registered a bundle')
assert.equal(captured.id, 'dsh-restart')

const fakeReact = { createElement: () => ({}) }
const mod = captured.factory((moduleName) => {
  if (moduleName === 'react') return fakeReact
  throw new Error('unexpected require: ' + moduleName)
})

assert.equal(mod.name, 'dsh-restart')
assert.deepEqual(mod.inject, ['slots', 'locale'])
assert.equal(typeof mod.apply, 'function')

let registeredDicts = null
let injectedSlot = null
let registeredOptions = null
let registeredComponent = null

const locale = {
  register: (ns, dict) => {
    assert.equal(ns, 'restart')
    registeredDicts = dict
    return () => {}
  },
  bind: (ns) => {
    assert.equal(ns, 'restart')
    return (key) => registeredDicts.en[key] ?? key
  },
}
const slots = {
  inject: (slot, factory) => {
    injectedSlot = slot
    return factory()
  },
  register: (options, component) => {
    registeredOptions = options
    registeredComponent = component
    return () => {}
  },
}
const ctx = {
  get: (service) => (service === 'locale' ? locale : service === 'slots' ? slots : undefined),
  effect: (fn) => { fn(); return () => {} },
}

mod.apply(ctx)

assert.equal(injectedSlot, 'settings.section')
assert.equal(registeredOptions.id, 'restart')
assert.equal(registeredOptions.order, 100)
assert.equal(registeredOptions.locale, 'restart')
assert.equal(typeof registeredOptions.label, 'function', 'nav label must be a thunk')
assert.equal(registeredOptions.label(), 'Restart')
assert.equal(typeof registeredComponent, 'function')

// zh/en key parity — the host rejects unbalanced dictionaries.
assert.deepEqual(
  Object.keys(registeredDicts.en).sort(),
  Object.keys(registeredDicts.zh).sort(),
  'en/zh dictionaries must carry the same keys',
)
assert.equal(registeredDicts.zh.sectionLabel, '重启')
assert.equal(registeredDicts.en.sectionLabel, 'Restart')
assert.ok(Object.keys(registeredDicts.en).length >= 20, 'dictionary is not a stub')

// The restart route and plugin toggle are wired in the injected api face.
const injected = registeredOptions.inject()
assert.equal(typeof injected.api.state, 'function')
assert.equal(typeof injected.api.setEnabled, 'function')
assert.equal(typeof injected.api.installCommunity, 'function')
assert.equal(typeof injected.api.restart, 'function')

console.log('client: bundle contract, slot wiring, api face, zh/en parity — ok')
