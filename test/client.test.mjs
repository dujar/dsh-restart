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
assert.equal(typeof injected.api.gitRefs, 'function')
assert.equal(typeof injected.api.gitCheckout, 'function')
assert.equal(typeof injected.api.uninstall, 'function')
assert.equal(typeof injected.api.reinstall, 'function')
assert.equal(typeof injected.api.restart, 'function')


// ---- pollRestart: the two-phase handoff that actually reloads the page ----
// The old process answers right up until it exits, so reloading on the first
// success would reload the OLD server and keep the stale settings. One
// failure must precede the success that triggers the reload. The clock is
// fake: each sleep advances it one second, so the give-up path is reachable
// without real timers.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
function makePoll(seq, opts) {
  const eventLog = []
  let i = 0
  let fakeNow = 0
  const o = {
    check: () => Promise.resolve(seq[Math.min(i++, seq.length - 1)]),
    reload: () => { eventLog.push('reload') },
    onProgress: (s) => { eventLog.push('progress:' + s) },
    onGiveUp: () => { eventLog.push('giveup') },
    interval: 1,
    giveUpAfter: 5,
    sleep: () => { fakeNow += 1000; return Promise.resolve() },
    now: () => fakeNow,
    ...(opts || {}),
  }
  const cancel = mod.pollRestart(o)
  return { eventLog, cancel, checkCalls: () => i }
}

let r = makePoll([true, false, true])
await flush()
assert.deepEqual(r.eventLog, ['progress:0', 'progress:1', 'reload'], 'up → down → up reloads exactly once')

r = makePoll([true, true, true, true, true, true], { giveUpAfter: 4 })
await flush()
assert.deepEqual(r.eventLog, ['progress:0', 'progress:1', 'progress:2', 'progress:3', 'giveup'], 'a server that never dies gives up instead of reloading the old page')

r = makePoll([false, true])
await flush()
assert.deepEqual(r.eventLog, ['progress:0', 'reload'], 'an already-down server reloads on the first success')

r = makePoll([false, false, true])
await flush()
assert.deepEqual(r.eventLog, ['progress:0', 'progress:1', 'reload'], 'down → down → up still reloads')

r = makePoll([true], { sleep: () => new Promise(() => {}) })
await flush()
r.cancel()
assert.deepEqual(r.eventLog, ['progress:0'], 'cancelling the poll stops the chain')

r = makePoll([true], { seenDown: true })
await flush()
assert.deepEqual(r.eventLog, ['reload'], 'seenDown from a cut-off POST reloads on the first success')

r = makePoll([false], { check: async () => { throw new Error('ENOTFOUND') }, giveUpAfter: 2 })
await flush()
assert.deepEqual(r.eventLog, ['progress:0', 'progress:1', 'giveup'], 'a throwing check counts as down, then gives up')

console.log('client: pollRestart handoff — ok')

