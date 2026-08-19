// Render smoke test: boot the client bundle with the REAL React from the dsh
// host install, capture the settings.section component, and server-render it
// to catch render-time errors (hook misuse, undefined variables, bad element
// shapes) that a plain smoke test cannot see. Skipped gracefully when the
// host React is not available at this path.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HOST_ROOT = '/home/bitslicer/.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules'
const REACT_PKG = HOST_ROOT + '/react/package.json'
if (!existsSync(REACT_PKG)) {
  console.log('render: host React not found — skipped')
  process.exit(0)
}

const hostRequire = createRequire(REACT_PKG)
const React = hostRequire('react')
const ReactDOMServer = hostRequire('react-dom/server')

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => { captured = definition },
  },
}

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
await import(clientPath + '?render=' + Date.now())
assert.ok(captured, 'client registered a bundle')

const mod = captured.factory((moduleName) => {
  if (moduleName === 'react') return React
  throw new Error('unexpected require: ' + moduleName)
})

let registeredOptions = null
let registeredComponent = null
let dicts = null

const locale = {
  register: (ns, d) => { dicts = d; return () => {} },
  bind: (ns) => (key) => (dicts ? (dicts.en[key] ?? key) : key),
}
const slots = {
  inject: (slot, factory) => factory(),
  register: (options, component) => { registeredOptions = options; registeredComponent = component; return () => {} },
}
const ctx = {
  get: (service) => (service === 'locale' ? locale : service === 'slots' ? slots : undefined),
  effect: (fn) => { fn(); return () => {} },
}
mod.apply(ctx)

assert.ok(registeredComponent, 'section component captured')

const api = {
  state: async () => ({ profile: 'web', plugins: [], community: { installed: false, enabled: false } }),
  setEnabled: async () => ({ ok: true }),
  restart: async () => ({ ok: true }),
}

const html = ReactDOMServer.renderToString(
  React.createElement(registeredComponent, { t: (key) => dicts.en[key] ?? key, api: api }),
)

assert.ok(html.includes('dshrt-root'), 'root class rendered')
assert.ok(html.includes('Restart'), 'section title rendered from en dict')
assert.ok(html.includes('Restart dsh web'), 'restart card rendered')
assert.ok(html.includes('Installed plugins'), 'plugins card rendered')
assert.ok(html.includes('More plugins'), 'more-plugins card rendered')
assert.ok(html.includes('Restart now'), 'primary restart button rendered')
assert.ok(html.includes('Loading…'), 'loading skeleton rendered before state arrives')

// The zh dict renders the same tree in Chinese.
const htmlZh = ReactDOMServer.renderToString(
  React.createElement(registeredComponent, { t: (key) => dicts.zh[key] ?? key, api: api }),
)
assert.ok(htmlZh.includes('重启 dsh web'), 'zh title rendered')
assert.ok(htmlZh.includes('立即重启'), 'zh restart button rendered')

console.log('render: section component server-renders in en and zh — ok')
