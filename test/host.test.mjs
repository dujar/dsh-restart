// Host-half tests for dsh-restart: state listing, plugin enable/disable,
// restart scheduling (with the spawn/exit stubbed so no real process is
// spawned and the test runner survives), and the trust guard.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-restart-test-'))
process.env.DSH_HOME = tmp
process.env.DSH_RESTART_CMD = 'sh -c "exit 0"'

mkdirSync(join(tmp, 'profiles', 'web'), { recursive: true })
writeFileSync(join(tmp, 'profiles', 'web', 'package.json'), JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dsh: { profile: { bundles: [
    '@deepseek-ai/dsh-base',
    'dsh-restart',
    'dsh-community-plugins',
    'dsh-trader',
  ] } },
  dependencies: {
    'dsh-community-plugins': 'link:/home/bitslicer/dev/2026_work/projects/hermes/dsh-community-plugins',
    'dsh-trader': 'github:owner/dsh-trader',
  },
}, null, 2) + '\n')

const mod = await import('../lib/index.js')
const routes = {}
mod.apply({ effect: (fn) => { fn(); return () => {} }, webServer: { register: (def) => { routes[def.path] = def; return () => {} } } })

function fakeReq(method, headers, body) {
  return {
    method,
    headers,
    url: '/',
    on(event, cb) {
      if (event === 'data' && body) cb(Buffer.from(body))
      if (event === 'end') cb()
    },
  }
}
function fakeRes() {
  const r = { status: 0, body: '' }
  r.writeHead = (s) => { r.status = s }
  r.end = (b) => { r.body = b }
  return r
}
const local = { host: '127.0.0.1:3080' }
const evil = { host: 'evil.example', origin: 'https://evil.example' }

// ---- GET /dsh-restart/state -------------------------------------------------
{
  const res = fakeRes()
  await routes['/dsh-restart/state'].handler(fakeReq('GET', local), res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.profile, 'web')
  assert.equal(body.plugins.length, 3)
  const byName = Object.fromEntries(body.plugins.map((p) => [p.name, p]))
  assert.equal(byName['dsh-restart'].enabled, true)
  assert.equal(byName['dsh-community-plugins'].enabled, true)
  assert.equal(byName['dsh-community-plugins'].repo, null, 'link: specs carry no repo')
  assert.equal(byName['dsh-trader'].enabled, true)
  assert.equal(byName['dsh-trader'].repo, 'owner/dsh-trader', 'github: specs carry a repo')
  assert.deepEqual(body.community, { installed: true, enabled: true })
}

// untrusted state read is rejected
{
  const res = fakeRes()
  await routes['/dsh-restart/state'].handler(fakeReq('GET', evil), res)
  assert.equal(res.status, 403)
}

// ---- POST /dsh-restart/plugin ------------------------------------------------
{
  const res = fakeRes()
  await routes['/dsh-restart/plugin'].handler(fakeReq('POST', local, JSON.stringify({ name: 'dsh-trader', enabled: false })), res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.needsRestart, true)
  assert.equal(body.enabled, false)
}
{
  const res = fakeRes()
  await routes['/dsh-restart/state'].handler(fakeReq('GET', local), res)
  const body = JSON.parse(res.body)
  assert.equal(body.plugins.find((p) => p.name === 'dsh-trader').enabled, false, 'manifest was rewritten')
}
{
  // unknown plugin is a 400
  const res = fakeRes()
  await routes['/dsh-restart/plugin'].handler(fakeReq('POST', local, JSON.stringify({ name: 'nope', enabled: true })), res)
  assert.equal(res.status, 400)
}
{
  // untrusted toggle is a 403 and does not touch the manifest
  const res = fakeRes()
  await routes['/dsh-restart/plugin'].handler(fakeReq('POST', evil, JSON.stringify({ name: 'dsh-community-plugins', enabled: false })), res)
  assert.equal(res.status, 403)
  const res2 = fakeRes()
  await routes['/dsh-restart/state'].handler(fakeReq('GET', local), res2)
  assert.equal(JSON.parse(res2.body).community.enabled, true)
}
// restore
{
  const res = fakeRes()
  await routes['/dsh-restart/plugin'].handler(fakeReq('POST', local, JSON.stringify({ name: 'dsh-trader', enabled: true })), res)
  assert.equal(JSON.parse(res.body).ok, true)
}

// ---- POST /dsh-restart --------------------------------------------------------
let exits = 0
let helper = null
mod._setRestartInternals({
  spawn: (file, args, opts) => { helper = { file, args, opts }; return { pid: 4242, unref: () => {}, on: () => {} } },
  exit: () => { exits += 1 },
})
{
  const res = fakeRes()
  await routes['/dsh-restart'].handler(fakeReq('POST', local), res)
  const body = JSON.parse(res.body)
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.restarting, true)
  assert.equal(exits, 0, 'the response lands before the process exits')

  assert.ok(helper, 'a detached restarter is scheduled')
  assert.equal(helper.file, process.execPath)
  assert.equal(helper.args[0], '-e')
  const code = helper.args[1]
  assert.ok(code.includes(JSON.stringify('sh -c "exit 0"')), 'DSH_RESTART_CMD override is embedded: ' + code.slice(0, 200))
  assert.ok(code.includes('const port = 3080'), 'default port is embedded')
  assert.ok(helper.opts.detached === true, 'restarter is detached')
  assert.equal(helper.opts.stdio, 'inherit', 'restarter inherits the terminal stdio')

  await new Promise((r) => setTimeout(r, 600))
  assert.equal(exits, 1, 'the process exits shortly after the response')
}
// untrusted restart never schedules anything
exits = 0
helper = null
{
  const res = fakeRes()
  await routes['/dsh-restart'].handler(fakeReq('POST', evil), res)
  assert.equal(res.status, 403)
  assert.equal(helper, null)
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(exits, 0)
}
// spawn failure surfaces as a 500 and never exits
{
  mod._setRestartInternals({ spawn: () => { throw new Error('boom') }, exit: () => { exits += 1 } })
  const res = fakeRes()
  await routes['/dsh-restart'].handler(fakeReq('POST', local), res)
  assert.equal(res.status, 500)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.ok(String(body.error).includes('boom'))
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(exits, 0)
}
mod._resetRestartInternals()

// ---- helpers ------------------------------------------------------------------
assert.equal(mod.dshPortFromArgs(['node', 'dsh', 'web', '--port', '3999']), 3999)
assert.equal(mod.dshPortFromArgs(['node', 'dsh', 'web', '--port=4100']), 4100)
assert.equal(mod.dshPortFromArgs(['node', 'dsh', 'web']), 3080)
assert.equal(mod.shellQuote("a'b"), "'a'\\''b'")

rmSync(tmp, { recursive: true, force: true })
console.log('host: state, toggle, restart (stubbed spawn/exit), trust guard, helpers — ok')
