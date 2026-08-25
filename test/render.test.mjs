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
assert.ok(html.includes('dujar/dsh-community-plugins'), 'advertised repo shown while community plugins are missing')
assert.ok(html.includes('Install dsh-community-plugins'), 'one-click install button rendered')

// The zh dict renders the same tree in Chinese.
const htmlZh = ReactDOMServer.renderToString(
  React.createElement(registeredComponent, { t: (key) => dicts.zh[key] ?? key, api: api }),
)
assert.ok(htmlZh.includes('重启 dsh web'), 'zh title rendered')
assert.ok(htmlZh.includes('立即重启'), 'zh restart button rendered')
assert.ok(htmlZh.includes('安装 dsh-community-plugins'), 'zh install button rendered')

// Regression: PluginRow renders the local git line (crashed with a bare `t`
// reference once — the section slot unmounted on the first real render).
const localPlugin = {
  name: 'dsh-pocket',
  enabled: true,
  repo: 'dujar/dsh-pocket',
  local: { path: '/home/x/dsh-pocket', git: true, branch: 'main', remoteName: 'origin', remoteUrl: 'https://github.com/dujar/dsh-pocket.git' },
}
const rowHtml = ReactDOMServer.renderToString(
  React.createElement(mod.PluginRow, {
    plugin: localPlugin,
    t: (key) => dicts.en[key] ?? key,
    pending: false,
    busy: false,
    disabled: false,
    onToggle: () => {},
  }),
)
assert.ok(rowHtml.includes('Local branch'), 'row shows local branch')
assert.ok(rowHtml.includes('origin/main'), 'row shows origin/branch')
assert.ok(rowHtml.includes('https://github.com/dujar/dsh-pocket.git'), 'row shows the remote url')
assert.ok(rowHtml.includes('dshrt-row-local'), 'row local line carries the class')

const buildRowHtml = ReactDOMServer.renderToString(
  React.createElement(mod.PluginRow, {
    plugin: { name: 'x', enabled: false, local: { path: '/tmp/x', git: false } },
    t: (key) => dicts.en[key] ?? key,
    pending: false,
    busy: false,
    disabled: false,
    onToggle: () => {},
  }),
)
assert.ok(buildRowHtml.includes('Local build'), 'plain local dir renders as local build')
assert.ok(buildRowHtml.includes('>Uninstall<'), 'uninstall button renders')
assert.ok(!buildRowHtml.includes('dshrt-git-divider'), 'reinstall panel closed by default')
// PluginRow with a git checkout renders the switch-branch chip (panel closed
// by default) and the local line.
{
  // A component is called through createElement — calling PluginRow(props)
  // directly returns an element tree, not a string, and renderToString was
  // never bound in this file.
  const row = ReactDOMServer.renderToString(React.createElement(mod.PluginRow, {
    t: (k) => dicts.en[k] ?? k,
    api: {},
    plugin: {
      name: 'dsh-x',
      enabled: true,
      local: { git: true, branch: 'main', remoteName: 'origin', remoteUrl: 'https://github.com/a/b.git', path: '/tmp/x' },
    },
    onRefresh: () => {},
  }))
  assert.ok(row.includes('Switch branch'), 'git switch chip rendered')
  assert.ok(!row.includes('dshrt-git"'), 'panel is closed by default')
  assert.ok(row.includes('Local branch · origin/main · https://github.com/a/b.git'), 'local line rendered')
}

// Broken link: warning bar + repair button render (en + zh); healthy renders none.
{
  const brokenPlugin = {
    name: 'dsh-pocket',
    enabled: true,
    local: { path: '/home/x/dsh-pocket', git: true, branch: 'main', remoteName: null, remoteUrl: null },
    link: { ok: false, reason: 'dir' },
  }
  const row = ReactDOMServer.renderToString(React.createElement(mod.PluginRow, {
    t: (k) => dicts.en[k] ?? k,
    api: { relink: async () => ({ ok: true }) },
    plugin: brokenPlugin,
    onRefresh: () => {},
    onNotice: () => {},
  }))
  assert.ok(row.includes('Link broken'), 'en link warning rendered')
  assert.ok(row.includes('node_modules entry is a real directory'), 'en broken reason rendered')
  assert.ok(row.includes('Repair link'), 'repair button rendered')
  assert.ok(row.includes('dshrt-linkwarn'), 'warning carries the class')
  const rowZh = ReactDOMServer.renderToString(React.createElement(mod.PluginRow, {
    t: (k) => dicts.zh[k] ?? k,
    api: { relink: async () => ({ ok: true }) },
    plugin: brokenPlugin,
    onRefresh: () => {},
    onNotice: () => {},
  }))
  assert.ok(rowZh.includes('链接已断开'), 'zh link warning rendered')
  assert.ok(rowZh.includes('修复链接'), 'zh repair button rendered')
  const healthyRow = ReactDOMServer.renderToString(React.createElement(mod.PluginRow, {
    t: (k) => dicts.en[k] ?? k,
    api: {},
    plugin: { ...brokenPlugin, link: { ok: true } },
    onRefresh: () => {},
    onNotice: () => {},
  }))
  assert.ok(!healthyRow.includes('dshrt-linkwarn'), 'healthy link renders no warning')
}

assert.equal(mod.localLine((k) => dicts.en[k] ?? k, { git: true, branch: 'wip', remoteName: null, remoteUrl: null }), 'Local branch · wip (no remote)')

console.log('render: section component server-renders in en and zh — ok')
