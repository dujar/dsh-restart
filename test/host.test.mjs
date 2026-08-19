// Host-half tests for dsh-restart: state listing, plugin enable/disable,
// restart scheduling (with the spawn/exit stubbed so no real process is
// spawned and the test runner survives), and the trust guard.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
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
  assert.deepEqual(body.community, { installed: true, enabled: true, repo: 'dujar/dsh-community-plugin' })
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

// ---- community detection accepts the published package name ------------------
const manifestPath = join(tmp, 'profiles', 'web', 'package.json')
{
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  raw.dsh.profile.bundles = raw.dsh.profile.bundles.map((n) => n === 'dsh-community-plugins' ? 'dsh-community-plugin' : n)
  delete raw.dependencies['dsh-community-plugins']
  raw.dependencies['dsh-community-plugin'] = 'github:dujar/dsh-community-plugin'
  writeFileSync(manifestPath, JSON.stringify(raw, null, 2) + '\n')
  const res = fakeRes()
  await routes['/dsh-restart/state'].handler(fakeReq('GET', local), res)
  const body = JSON.parse(res.body)
  assert.deepEqual(body.community, { installed: true, enabled: true, repo: 'dujar/dsh-community-plugin' })
  assert.ok(body.plugins.some((p) => p.name === 'dsh-community-plugin' && p.repo === 'dujar/dsh-community-plugin'))
  // restore the manifest for the later tests
  const back = JSON.parse(readFileSync(manifestPath, 'utf8'))
  back.dsh.profile.bundles = back.dsh.profile.bundles.map((n) => n === 'dsh-community-plugin' ? 'dsh-community-plugins' : n)
  delete back.dependencies['dsh-community-plugin']
  back.dependencies['dsh-community-plugins'] = 'link:/home/bitslicer/dev/2026_work/projects/hermes/dsh-community-plugins'
  writeFileSync(manifestPath, JSON.stringify(back, null, 2) + '\n')
}

// ---- POST /dsh-restart/community ----------------------------------------------
function stubSpawn(stdout, stderr, code) {
  return (bin, args, opts) => {
    captured = { bin, args, opts }
    return {
      stdout: { on: (ev, cb) => { if (ev === 'data') cb(Buffer.from(stdout)) } },
      stderr: { on: (ev, cb) => { if (ev === 'data' && stderr) cb(Buffer.from(stderr)) } },
      on: (ev, cb) => {
        if (ev === 'error') { /* swallow */ }
        if (ev === 'close') setTimeout(() => cb(code), 5)
      },
    }
  }
}
let captured = null
const prevBin = process.env.DSH_BIN
process.env.DSH_BIN = 'dsh-test'
{
  mod._setInstallInternals({ spawn: stubSpawn('installed ok', '', 0) })
  const res = fakeRes()
  await routes['/dsh-restart/community'].handler(fakeReq('POST', local), res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.profile, 'web')
  assert.equal(body.output, 'installed ok')
  assert.ok(captured, 'spawn ran')
  assert.equal(captured.bin, 'dsh-test', 'DSH_BIN overrides the executable')
  assert.deepEqual(captured.args, ['plugin', '--profile', 'web', 'add', 'github:dujar/dsh-community-plugin'])
}
{
  // a failing install (e.g. repo not published yet) surfaces a 500 with stderr
  mod._setInstallInternals({ spawn: stubSpawn('', 'repo not found (404)', 1) })
  const res = fakeRes()
  await routes['/dsh-restart/community'].handler(fakeReq('POST', local), res)
  assert.equal(res.status, 500)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.ok(String(body.error).includes('repo not found'))
}
{
  // untrusted install is a 403 and never spawns
  captured = null
  const res = fakeRes()
  await routes['/dsh-restart/community'].handler(fakeReq('POST', evil), res)
  assert.equal(res.status, 403)
  assert.equal(captured, null)
}
mod._resetInstallInternals()
if (prevBin === undefined) delete process.env.DSH_BIN
else process.env.DSH_BIN = prevBin

// ---- local git metadata -------------------------------------------------------
const pluginsDir = join(tmp, 'plugins')
mkdirSync(join(pluginsDir, 'plugin-a', '.git'), { recursive: true })
writeFileSync(join(pluginsDir, 'plugin-a', '.git', 'HEAD'), 'ref: refs/heads/feature/x\n')
writeFileSync(join(pluginsDir, 'plugin-a', '.git', 'config'),
  '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:acme/plugin-a.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')
// worktree: .git is a file pointing at a separate gitdir
mkdirSync(join(pluginsDir, 'plugin-b'), { recursive: true })
mkdirSync(join(pluginsDir, 'plugin-b-git'), { recursive: true })
writeFileSync(join(pluginsDir, 'plugin-b', '.git'), 'gitdir: ' + join(pluginsDir, 'plugin-b-git') + '\n')
writeFileSync(join(pluginsDir, 'plugin-b-git', 'HEAD'), 'ref: refs/heads/main\n')
writeFileSync(join(pluginsDir, 'plugin-b-git', 'config'), '[remote "upstream"]\n\turl = https://github.com/acme/plugin-b\n')
// plain local dir, no git
mkdirSync(join(pluginsDir, 'plugin-c'), { recursive: true })

mkdirSync(join(tmp, 'profiles', 'web2'), { recursive: true })
writeFileSync(join(tmp, 'profiles', 'web2', 'package.json'), JSON.stringify({
  name: 'dsh-profile-web2',
  private: true,
  dsh: { profile: { bundles: ['dsh-restart', 'plugin-a', 'plugin-b', 'plugin-c'] } },
  dependencies: {
    'plugin-a': 'link:' + join(pluginsDir, 'plugin-a'),
    'plugin-b': 'link:' + join(pluginsDir, 'plugin-b'),
    'plugin-c': 'file:' + join(pluginsDir, 'plugin-c'),
  },
}, null, 2) + '\n')

assert.deepEqual(mod.parseGitRemote('[remote "origin"]\n\turl = git@github.com:a/b.git\n'), { name: 'origin', url: 'git@github.com:a/b.git' })
assert.equal(mod.parseGitRemote('[core]\n\tbare = true\n'), null)
assert.equal(mod.parseGitRemote(''), null)

process.env.DSH_RESTART_PROFILE = 'web2'
try {
  const res = fakeRes()
  await routes['/dsh-restart/state'].handler(fakeReq('GET', local), res)
  assert.equal(res.status, 200)
  const byName = Object.fromEntries(JSON.parse(res.body).plugins.map((p) => [p.name, p]))
  assert.equal(byName['plugin-a'].local.git, true)
  assert.equal(byName['plugin-a'].local.branch, 'feature/x')
  assert.equal(byName['plugin-a'].local.remoteName, 'origin')
  assert.equal(byName['plugin-a'].local.remoteUrl, 'git@github.com:acme/plugin-a.git')
  assert.equal(byName['plugin-b'].local.git, true, 'worktree .git pointer resolved')
  assert.equal(byName['plugin-b'].local.branch, 'main')
  assert.equal(byName['plugin-b'].local.remoteName, 'upstream')
  assert.equal(byName['plugin-c'].local.git, false, 'plain local dir is a local build')
  assert.equal(byName['plugin-c'].local.path, join(pluginsDir, 'plugin-c'))
  assert.equal(byName['dsh-restart'].local, null, 'no local metadata without a local spec')
} finally {
  delete process.env.DSH_RESTART_PROFILE
}

// ---- helpers ------------------------------------------------------------------
assert.equal(mod.dshPortFromArgs(['node', 'dsh', 'web', '--port', '3999']), 3999)
assert.equal(mod.dshPortFromArgs(['node', 'dsh', 'web', '--port=4100']), 4100)
assert.equal(mod.dshPortFromArgs(['node', 'dsh', 'web']), 3080)
assert.equal(mod.shellQuote("a'b"), "'a'\\''b'")

rmSync(tmp, { recursive: true, force: true })
console.log('host: state, toggle, restart (stubbed spawn/exit), community install (stubbed), trust guard, helpers — ok')
