// Host-half tests for dsh-restart: state listing, plugin enable/disable,
// restart scheduling (with the spawn/exit stubbed so no real process is
// spawned and the test runner survives), and the trust guard.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
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

function fakeReq(method, headers, url, body) {
  if (typeof url === 'object' && url !== null || typeof url === 'string' && url.startsWith('{')) {
    body = url
    url = '/'
  }
  return {
    method,
    headers,
    url: url || '/',
    on(event, cb) {
      if (event === 'data' && body) cb(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
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
mkdirSync(join(pluginsDir, 'plugin-a', '.git', 'refs', 'heads', 'feature'), { recursive: true })
mkdirSync(join(pluginsDir, 'plugin-a', '.git', 'refs', 'remotes', 'origin'), { recursive: true })
mkdirSync(join(pluginsDir, 'plugin-a', '.git', 'refs', 'remotes', 'upstream'), { recursive: true })
writeFileSync(join(pluginsDir, 'plugin-a', '.git', 'HEAD'), 'ref: refs/heads/feature/x\n')
writeFileSync(join(pluginsDir, 'plugin-a', '.git', 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n')
writeFileSync(join(pluginsDir, 'plugin-a', '.git', 'refs', 'heads', 'feature', 'x'), 'b'.repeat(40) + '\n')
writeFileSync(join(pluginsDir, 'plugin-a', '.git', 'refs', 'remotes', 'origin', 'main'), 'c'.repeat(40) + '\n')
writeFileSync(join(pluginsDir, 'plugin-a', '.git', 'refs', 'remotes', 'origin', 'dev'), 'd'.repeat(40) + '\n')
writeFileSync(join(pluginsDir, 'plugin-a', '.git', 'refs', 'remotes', 'upstream', 'main'), 'e'.repeat(40) + '\n')
writeFileSync(join(pluginsDir, 'plugin-a', '.git', 'config'),
  '[core]\n\trepositoryformatversion = 0\n' +
  '[remote "origin"]\n\turl = git@github.com:acme/plugin-a.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' +
  '[remote "upstream"]\n\turl = https://github.com/acme/plugin-a-upstream\n\tfetch = +refs/heads/*:refs/remotes/upstream/*\n' +
  '[branch "feature/x"]\n\tremote = origin\n\tmerge = refs/heads/feature/x\n')
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

// ---- GET /dsh-restart/git-refs -------------------------------------------------
process.env.DSH_RESTART_PROFILE = 'web2'
try {
  {
    const res = fakeRes()
    await routes['/dsh-restart/git-refs'].handler(fakeReq('GET', local, '/dsh-restart/git-refs?name=plugin-a'), res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.head, 'feature/x')
    assert.deepEqual(body.local, ['feature/x', 'main'])
    assert.equal(body.remotes.length, 2, 'both remotes listed')
    assert.equal(body.remotes[0].name, 'origin')
    assert.equal(body.remotes[0].url, 'git@github.com:acme/plugin-a.git')
    assert.deepEqual(body.remotes[0].branches, ['dev', 'main'])
    assert.equal(body.remotes[1].name, 'upstream')
    assert.deepEqual(body.remotes[1].branches, ['main'])
    assert.deepEqual(body.tracked, { remote: 'origin', branch: 'feature/x' })
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/git-refs'].handler(fakeReq('GET', local, '/dsh-restart/git-refs?name=plugin-b'), res)
    assert.equal(JSON.parse(res.body).ok, true, 'worktree gitdir refs resolve')
    assert.equal(JSON.parse(res.body).head, 'main')
    assert.equal(JSON.parse(res.body).remotes[0].name, 'upstream')
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/git-refs'].handler(fakeReq('GET', local, '/dsh-restart/git-refs?name=plugin-c'), res)
    assert.equal(res.status, 404)
    assert.match(JSON.parse(res.body).error, /not a git checkout/)
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/git-refs'].handler(fakeReq('GET', local, '/dsh-restart/git-refs?name=dsh-restart'), res)
    assert.equal(res.status, 404)
    assert.match(JSON.parse(res.body).error, /not a local plugin/)
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/git-refs'].handler(fakeReq('GET', local, '/dsh-restart/git-refs'), res)
    assert.equal(res.status, 400)
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/git-refs'].handler(fakeReq('GET', evil, '/dsh-restart/git-refs?name=plugin-a'), res)
    assert.equal(res.status, 403)
  }
} finally {
  delete process.env.DSH_RESTART_PROFILE
}

// ---- POST /dsh-restart/git-checkout --------------------------------------------
const pluginAPath = join(pluginsDir, 'plugin-a')
let gitSpawned = null
mod._setGitInternals({
  spawn(bin, args, opts) {
    gitSpawned = { bin, args, opts }
    return {
      stdout: { on: (ev, cb) => { if (ev === 'data') cb(Buffer.from('Switched to branch "main"\n')) } },
      stderr: { on: () => {} },
      on: (ev, cb) => { if (ev === 'close') setTimeout(() => cb(0), 5) },
    }
  },
})
process.env.DSH_RESTART_PROFILE = 'web2'
try {
  {
    const res = fakeRes()
    await routes['/dsh-restart/git-checkout'].handler(fakeReq('POST', local, '/dsh-restart/git-checkout', { name: 'plugin-a', branch: 'main' }), res)
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).ok, true)
    assert.deepEqual(gitSpawned.args, ['-C', pluginAPath, 'checkout', 'main'], 'plain local checkout')
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/git-checkout'].handler(fakeReq('POST', local, '/dsh-restart/git-checkout', { name: 'plugin-a', branch: 'main', remote: 'origin' }), res)
    assert.deepEqual(gitSpawned.args, ['-C', pluginAPath, 'checkout', 'main'], 'remote branch that exists locally checks out directly')
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/git-checkout'].handler(fakeReq('POST', local, '/dsh-restart/git-checkout', { name: 'plugin-a', branch: 'dev', remote: 'origin' }), res)
    assert.deepEqual(gitSpawned.args, ['-C', pluginAPath, 'checkout', '-b', 'dev', 'origin/dev'], 'remote branch without local ref creates tracking branch')
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/git-checkout'].handler(fakeReq('POST', local, '/dsh-restart/git-checkout', { name: 'plugin-a', branch: '-rf' }), res)
    assert.equal(res.status, 400, 'option-like branch names rejected')
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/git-checkout'].handler(fakeReq('POST', local, '/dsh-restart/git-checkout', { name: 'plugin-a', branch: 'feature/x', remote: 'upstream' }), res)
    assert.equal(res.status, 200)
    assert.deepEqual(gitSpawned.args, ['-C', pluginAPath, 'branch', '--set-upstream-to', 'upstream/feature/x', 'feature/x'],
      'same branch name from a different remote retargets the upstream')
  }
  {
    gitSpawned = null
    const res = fakeRes()
    await routes['/dsh-restart/git-checkout'].handler(fakeReq('POST', local, '/dsh-restart/git-checkout', { name: 'plugin-a', branch: 'feature/x', remote: 'origin' }), res)
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).noop, true, 'already tracking that remote is a no-op')
    assert.equal(gitSpawned, null, 'no git spawned for a no-op')
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/git-checkout'].handler(fakeReq('POST', local, '/dsh-restart/git-checkout', { name: 'plugin-a', branch: 'feature/x' }), res)
    assert.deepEqual(gitSpawned.args, ['-C', pluginAPath, 'branch', '--unset-upstream', 'feature/x'],
      'current branch back to local unsets the upstream')
  }
  {
    gitSpawned = null
    const res = fakeRes()
    await routes['/dsh-restart/git-checkout'].handler(fakeReq('POST', local, '/dsh-restart/git-checkout', { name: 'plugin-b', branch: 'main' }), res)
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).noop, true, 'an untracked current branch is already local')
    assert.equal(gitSpawned, null)
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/git-checkout'].handler(fakeReq('POST', local, '/dsh-restart/git-checkout', { name: 'plugin-c', branch: 'main' }), res)
    assert.equal(res.status, 404, 'non-git local dir rejected')
  }
  {
    gitSpawned = null
    const res = fakeRes()
    await routes['/dsh-restart/git-checkout'].handler(fakeReq('POST', evil, '/dsh-restart/git-checkout', { name: 'plugin-a', branch: 'main' }), res)
    assert.equal(res.status, 403, 'untrusted checkout rejected')
    assert.equal(gitSpawned, null, 'git never spawned for untrusted request')
  }
} finally {
  delete process.env.DSH_RESTART_PROFILE
  mod._resetGitInternals()
}

// failing git run surfaces stderr
{
  mod._setGitInternals({
    spawn() {
      return {
        stdout: { on: () => {} },
        stderr: { on: (ev, cb) => { if (ev === 'data') cb(Buffer.from('error: your local changes would be overwritten by checkout')) } },
        on: (ev, cb) => { if (ev === 'close') setTimeout(() => cb(1), 5) },
      }
    },
  })
  process.env.DSH_RESTART_PROFILE = 'web2'
  try {
    const res = fakeRes()
    await routes['/dsh-restart/git-checkout'].handler(fakeReq('POST', local, '/dsh-restart/git-checkout', { name: 'plugin-a', branch: 'main' }), res)
    assert.equal(res.status, 500)
    assert.equal(JSON.parse(res.body).ok, false)
    assert.match(JSON.parse(res.body).error, /local changes/)
  } finally {
    delete process.env.DSH_RESTART_PROFILE
    mod._resetGitInternals()
  }
}

// ---- POST /dsh-restart/uninstall -----------------------------------------------
const web3 = join(tmp, 'profiles', 'web3')
mkdirSync(web3, { recursive: true })
writeFileSync(join(web3, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web3',
  private: true,
  dsh: { profile: { bundles: ['dsh-restart', 'dsh-better-archive'] } },
  dependencies: { 'dsh-better-archive': 'link:' + join(pluginsDir, 'plugin-c') },
}, null, 2) + '\n')
process.env.DSH_RESTART_PROFILE = 'web3'
try {
  {
    const res = fakeRes()
    await routes['/dsh-restart/uninstall'].handler(fakeReq('POST', local, '/dsh-restart/uninstall', { name: 'dsh-better-archive' }), res)
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body).removed, { bundles: true, deps: true })
    const manifest = JSON.parse(readFileSync(join(web3, 'package.json'), 'utf8'))
    assert.ok(!manifest.dsh.profile.bundles.includes('dsh-better-archive'), 'removed from bundles')
    assert.equal(manifest.dependencies['dsh-better-archive'], undefined, 'removed from dependencies')
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/uninstall'].handler(fakeReq('POST', local, '/dsh-restart/uninstall', { name: 'dsh-restart' }), res)
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body).removed, { bundles: true, deps: false }, 'bundles-only removal')
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/uninstall'].handler(fakeReq('POST', local, '/dsh-restart/uninstall', { name: 'nope' }), res)
    assert.equal(res.status, 404, 'not installed')
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/uninstall'].handler(fakeReq('POST', local, '/dsh-restart/uninstall', { name: '@deepseek-ai/foo' }), res)
    assert.equal(res.status, 400, 'builtins cannot be uninstalled')
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/uninstall'].handler(fakeReq('POST', evil, '/dsh-restart/uninstall', { name: 'dsh-restart' }), res)
    assert.equal(res.status, 403)
  }
} finally {
  delete process.env.DSH_RESTART_PROFILE
}

// ---- POST /dsh-restart/reinstall -----------------------------------------------
const reinstallSpawns = []
const relinkSpawns = []
mod._setGitInternals({
  spawn(bin, args) {
    reinstallSpawns.push(args)
    return {
      stdout: { on: (ev, cb) => { if (ev === 'data') cb(Buffer.from('done\n')) } },
      stderr: { on: () => {} },
      on: (ev, cb) => { if (ev === 'close') setTimeout(() => cb(0), 5) },
    }
  },
})
// The reinstall route auto-repairs a broken link (web2 has no node_modules at
// all, so every link: entry reads as missing) — stub the dsh spawn it uses.
mod._setInstallInternals({
  spawn(bin, args) {
    relinkSpawns.push(args)
    return {
      stdout: { on: (ev, cb) => { if (ev === 'data') cb(Buffer.from('ok\n')) } },
      stderr: { on: () => {} },
      on: (ev, cb) => { if (ev === 'close') setTimeout(() => cb(0), 5) },
    }
  },
})
process.env.DSH_RESTART_PROFILE = 'web2'
try {
  {
    const res = fakeRes()
    await routes['/dsh-restart/reinstall'].handler(fakeReq('POST', local, '/dsh-restart/reinstall', { name: 'plugin-a' }), res)
    assert.equal(res.status, 200)
    assert.deepEqual(reinstallSpawns, [
      ['-C', pluginAPath, 'reset', '--hard'],
      ['-C', pluginAPath, 'clean', '-fdx'],
    ], 'local source resets the checkout and cleans')
    const body = JSON.parse(res.body)
    assert.deepEqual(body.deps, { status: 'skipped', reason: 'no package.json' }, 'no package.json means deps restore is skipped')
    assert.equal(body.relink.attempted, true, 'a broken link triggers the auto-repair')
    assert.equal(body.relink.ok, true)
    assert.deepEqual(relinkSpawns, [['plugin', '--profile', 'web2', 'install']], 'repair re-syncs the profile install')
  }
  reinstallSpawns.length = 0
  relinkSpawns.length = 0
  {
    const res = fakeRes()
    await routes['/dsh-restart/reinstall'].handler(fakeReq('POST', local, '/dsh-restart/reinstall', { name: 'plugin-a', remote: 'origin' }), res)
    assert.equal(res.status, 200)
    assert.deepEqual(reinstallSpawns, [
      ['-C', pluginAPath, 'fetch', 'origin'],
      ['-C', pluginAPath, 'reset', '--hard', 'origin/main'],
      ['-C', pluginAPath, 'checkout', '-B', 'main'],
      ['-C', pluginAPath, 'clean', '-fdx'],
    ], 'remote source fetches, hard-resets to its default branch, and cleans')
    assert.deepEqual(relinkSpawns, [['plugin', '--profile', 'web2', 'install']], 'remote source auto-repairs the link too')
  }
  relinkSpawns.length = 0
  {
    const res = fakeRes()
    await routes['/dsh-restart/reinstall'].handler(fakeReq('POST', local, '/dsh-restart/reinstall', { name: 'plugin-a', remote: 'nowhere' }), res)
    assert.equal(res.status, 400, 'unknown remote rejected')
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/reinstall'].handler(fakeReq('POST', local, '/dsh-restart/reinstall', { name: 'plugin-c' }), res)
    assert.equal(res.status, 404, 'non-git local dir rejected')
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/reinstall'].handler(fakeReq('POST', evil, '/dsh-restart/reinstall', { name: 'plugin-a', remote: 'origin' }), res)
    assert.equal(res.status, 403)
  }
} finally {
  delete process.env.DSH_RESTART_PROFILE
  mod._resetGitInternals()
  mod._resetInstallInternals()
}

// a failing reinstall step aborts with its stderr
{
  const failSpawns = []
  mod._setGitInternals({
    spawn(bin, args) {
      failSpawns.push(args)
      return {
        stdout: { on: () => {} },
        stderr: { on: (ev, cb) => { if (ev === 'data') cb(Buffer.from('fatal: unable to access')) } },
        on: (ev, cb) => { if (ev === 'close') setTimeout(() => cb(128), 5) },
      }
    },
  })
  process.env.DSH_RESTART_PROFILE = 'web2'
  try {
    const res = fakeRes()
    await routes['/dsh-restart/reinstall'].handler(fakeReq('POST', local, '/dsh-restart/reinstall', { name: 'plugin-a', remote: 'origin' }), res)
    assert.equal(res.status, 500)
    assert.match(JSON.parse(res.body).error, /unable to access/)
    assert.equal(JSON.parse(res.body).step, 'fetch', 'failing step reported')
    assert.equal(failSpawns.length, 1, 'aborts after the first failing step')
  } finally {
    delete process.env.DSH_RESTART_PROFILE
    mod._resetGitInternals()
  }
}

// ---- link health in state (web4 healthy, web5 broken) -------------------------
const web4 = join(tmp, 'profiles', 'web4')
const web5 = join(tmp, 'profiles', 'web5')
mkdirSync(join(web4, 'node_modules'), { recursive: true })
mkdirSync(join(web5, 'node_modules'), { recursive: true })
const pluginBPath = join(pluginsDir, 'plugin-b')
const pluginCPath = join(pluginsDir, 'plugin-c')
symlinkSync(pluginAPath, join(web4, 'node_modules', 'plugin-a'))
symlinkSync(pluginCPath, join(web4, 'node_modules', 'plugin-c'))
symlinkSync(pluginCPath, join(web5, 'node_modules', 'plugin-a'))
mkdirSync(join(web5, 'node_modules', 'plugin-b'))
symlinkSync(join(pluginsDir, 'gone'), join(web5, 'node_modules', 'plugin-d'))
writeFileSync(join(web4, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web4',
  private: true,
  dsh: { profile: { bundles: ['dsh-restart', 'plugin-a', 'plugin-c', 'dsh-plain'] } },
  dependencies: {
    'plugin-a': 'link:' + pluginAPath,
    'plugin-c': 'file:' + pluginCPath,
    'dsh-plain': '^1.0.0',
  },
}, null, 2) + '\n')
writeFileSync(join(web5, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web5',
  private: true,
  dsh: { profile: { bundles: ['dsh-restart', 'plugin-a', 'plugin-b', 'plugin-d'] } },
  dependencies: {
    'plugin-a': 'link:' + pluginAPath,
    'plugin-b': 'link:' + pluginBPath,
    'plugin-d': 'link:' + join(pluginsDir, 'gone'),
  },
}, null, 2) + '\n')

process.env.DSH_RESTART_PROFILE = 'web4'
try {
  const res = fakeRes()
  await routes['/dsh-restart/state'].handler(fakeReq('GET', local), res)
  const byName = Object.fromEntries(JSON.parse(res.body).plugins.map((p) => [p.name, p]))
  assert.deepEqual(byName['plugin-a'].link, { ok: true }, 'link: symlink matching the checkout is healthy')
  assert.deepEqual(byName['plugin-c'].link, { ok: true }, 'a present file: entry counts as healthy')
  assert.equal(byName['dsh-plain'].link, null, 'registry specs carry no link health')
  assert.equal(byName['dsh-restart'].link, null)
} finally {
  delete process.env.DSH_RESTART_PROFILE
}
process.env.DSH_RESTART_PROFILE = 'web5'
try {
  const res = fakeRes()
  await routes['/dsh-restart/state'].handler(fakeReq('GET', local), res)
  const byName = Object.fromEntries(JSON.parse(res.body).plugins.map((p) => [p.name, p]))
  assert.deepEqual(byName['plugin-a'].link, { ok: false, reason: 'mismatch' }, 'a symlink pointing elsewhere is a mismatch')
  assert.deepEqual(byName['plugin-b'].link, { ok: false, reason: 'dir' }, 'a real directory entry is broken')
  assert.deepEqual(byName['plugin-d'].link, { ok: false, reason: 'dangling' }, 'a symlink to a missing target is dangling')
} finally {
  delete process.env.DSH_RESTART_PROFILE
}
assert.deepEqual(await mod.linkHealthOf('web2', 'plugin-a', 'link:' + pluginAPath), { ok: false, reason: 'missing' }, 'no node_modules entry reads as missing')

// ---- restoreDeps: package-manager detection + results -------------------------
const depsCheckout = join(tmp, 'deps-checkout')
mkdirSync(depsCheckout, { recursive: true })
const depsSpawns = []
mod._setDepsInternals({
  spawn(bin, args, opts) {
    depsSpawns.push({ bin, args, opts })
    return {
      stdout: { on: (ev, cb) => { if (ev === 'data') cb(Buffer.from('ok\n')) } },
      stderr: { on: () => {} },
      on: (ev, cb) => { if (ev === 'close') setTimeout(() => cb(0), 5) },
    }
  },
})
try {
  {
    writeFileSync(join(depsCheckout, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { a: '^1' } }))
    writeFileSync(join(depsCheckout, 'package-lock.json'), '{}')
    writeFileSync(join(depsCheckout, 'pnpm-lock.yaml'), '')
    const result = await mod.restoreDeps(depsCheckout)
    assert.equal(result.status, 'installed')
    assert.equal(depsSpawns.length, 1)
    assert.equal(depsSpawns[0].bin, process.env.NPM_BIN || 'npm', 'package-lock.json wins -> npm')
    assert.deepEqual(depsSpawns[0].args, ['install'])
    assert.equal(depsSpawns[0].opts.cwd, depsCheckout, 'install runs inside the checkout')
  }
  depsSpawns.length = 0
  {
    rmSync(join(depsCheckout, 'package-lock.json'))
    const result = await mod.restoreDeps(depsCheckout)
    assert.equal(result.status, 'installed')
    assert.equal(depsSpawns[0].bin, process.env.PNPM_BIN || 'pnpm', 'pnpm-lock.yaml alone picks pnpm')
  }
  depsSpawns.length = 0
  {
    rmSync(join(depsCheckout, 'pnpm-lock.yaml'))
    const result = await mod.restoreDeps(depsCheckout)
    assert.equal(result.status, 'installed')
    assert.equal(depsSpawns[0].bin, process.env.NPM_BIN || 'npm', 'deps without a lockfile fall back to npm')
  }
  depsSpawns.length = 0
  {
    writeFileSync(join(depsCheckout, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }))
    const result = await mod.restoreDeps(depsCheckout)
    assert.equal(result.status, 'skipped')
    assert.equal(depsSpawns.length, 0, 'no dependencies means no install')
  }
  depsSpawns.length = 0
  {
    rmSync(join(depsCheckout, 'package.json'))
    const result = await mod.restoreDeps(depsCheckout)
    assert.equal(result.status, 'skipped')
    assert.equal(result.reason, 'no package.json')
  }
} finally {
  mod._resetDepsInternals()
}
// a failing dependency install surfaces stderr, not an exception
mod._setDepsInternals({
  spawn() {
    return {
      stdout: { on: () => {} },
      stderr: { on: (ev, cb) => { if (ev === 'data') cb(Buffer.from('ERR! not found')) } },
      on: (ev, cb) => { if (ev === 'close') setTimeout(() => cb(1), 5) },
    }
  },
})
{
  writeFileSync(join(depsCheckout, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { a: '^1' } }))
  const result = await mod.restoreDeps(depsCheckout)
  assert.equal(result.status, 'failed')
  assert.match(result.error, /not found/)
}
mod._resetDepsInternals()

// ---- POST /dsh-restart/relink ------------------------------------------------
let relinkCaptured = null
process.env.DSH_BIN = 'dsh-test'
mod._setInstallInternals({
  spawn(bin, args, opts) {
    relinkCaptured = { bin, args, opts }
    return stubSpawn('relinked ok', '', 0)(bin, args, opts)
  },
})
process.env.DSH_RESTART_PROFILE = 'web4'
try {
  {
    const res = fakeRes()
    await routes['/dsh-restart/relink'].handler(fakeReq('POST', local, '/dsh-restart/relink', { name: 'plugin-a' }), res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.output, 'relinked ok')
    assert.equal(relinkCaptured.bin, 'dsh-test', 'DSH_BIN overrides the executable')
    assert.deepEqual(relinkCaptured.args, ['plugin', '--profile', 'web4', 'install'])
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/relink'].handler(fakeReq('POST', local, '/dsh-restart/relink', { name: '@deepseek-ai/foo' }), res)
    assert.equal(res.status, 400, 'builtins cannot be relinked')
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/relink'].handler(fakeReq('POST', local, '/dsh-restart/relink', { name: 'nope' }), res)
    assert.equal(res.status, 404, 'not installed')
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/relink'].handler(fakeReq('POST', local, '/dsh-restart/relink', { name: 'dsh-plain' }), res)
    assert.equal(res.status, 400, 'registry spec is not a local plugin')
  }
  {
    relinkCaptured = null
    const res = fakeRes()
    await routes['/dsh-restart/relink'].handler(fakeReq('POST', evil, '/dsh-restart/relink', { name: 'plugin-a' }), res)
    assert.equal(res.status, 403)
    assert.equal(relinkCaptured, null, 'untrusted request never spawns')
  }
  {
    mod._setInstallInternals({ spawn: stubSpawn('', 'pnpm failed', 1) })
    const res = fakeRes()
    await routes['/dsh-restart/relink'].handler(fakeReq('POST', local, '/dsh-restart/relink', { name: 'plugin-a' }), res)
    assert.equal(res.status, 500)
    assert.match(JSON.parse(res.body).error, /pnpm failed/)
  }
} finally {
  delete process.env.DSH_RESTART_PROFILE
  mod._resetInstallInternals()
  if (prevBin === undefined) delete process.env.DSH_BIN
  else process.env.DSH_BIN = prevBin
}

// ---- reinstall from the plugin origin (remote: 'plugin') ----------------------
process.env.DSH_BIN = 'dsh-test'
process.env.DSH_RESTART_PROFILE = 'web4'
try {
  {
    mod._setInstallInternals({
      spawn(bin, args, opts) {
        relinkCaptured = { bin, args, opts }
        return stubSpawn('added ok', '', 0)(bin, args, opts)
      },
    })
    const res = fakeRes()
    await routes['/dsh-restart/reinstall'].handler(fakeReq('POST', local, '/dsh-restart/reinstall', { name: 'plugin-a', remote: 'plugin' }), res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.unlinked, true)
    assert.equal(body.checkout, pluginAPath, 'the checkout path is reported, never deleted')
    assert.deepEqual(relinkCaptured.args, ['plugin', '--profile', 'web4', 'add', 'plugin-a@latest'])
    assert.ok(readFileSync(join(pluginAPath, '.git', 'HEAD'), 'utf8').includes('feature/x'), 'checkout on disk is untouched')
  }
  {
    const res = fakeRes()
    await routes['/dsh-restart/reinstall'].handler(fakeReq('POST', local, '/dsh-restart/reinstall', { name: 'dsh-plain', remote: 'plugin' }), res)
    assert.equal(res.status, 400, 'a registry dep has no local checkout to de-link')
  }
  {
    relinkCaptured = null
    const res = fakeRes()
    await routes['/dsh-restart/reinstall'].handler(fakeReq('POST', evil, '/dsh-restart/reinstall', { name: 'plugin-a', remote: 'plugin' }), res)
    assert.equal(res.status, 403)
    assert.equal(relinkCaptured, null)
  }
} finally {
  delete process.env.DSH_RESTART_PROFILE
  mod._resetInstallInternals()
  if (prevBin === undefined) delete process.env.DSH_BIN
  else process.env.DSH_BIN = prevBin
}

// ---- auto-repair edge cases ---------------------------------------------------
// healthy link: no repair spawn
{
  mod._setGitInternals({
    spawn() {
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (ev, cb) => { if (ev === 'close') setTimeout(() => cb(0), 5) },
      }
    },
  })
  let installSpawned = false
  mod._setInstallInternals({
    spawn() {
      installSpawned = true
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (ev, cb) => { if (ev === 'close') setTimeout(() => cb(0), 5) },
      }
    },
  })
  process.env.DSH_RESTART_PROFILE = 'web4'
  try {
    const res = fakeRes()
    await routes['/dsh-restart/reinstall'].handler(fakeReq('POST', local, '/dsh-restart/reinstall', { name: 'plugin-a' }), res)
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body).relink, { attempted: false }, 'a healthy link needs no repair')
    assert.equal(installSpawned, false)
  } finally {
    delete process.env.DSH_RESTART_PROFILE
    mod._resetGitInternals()
    mod._resetInstallInternals()
  }
}
// broken link whose repair fails still reports success with relink.ok:false
{
  mod._setGitInternals({
    spawn() {
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (ev, cb) => { if (ev === 'close') setTimeout(() => cb(0), 5) },
      }
    },
  })
  mod._setInstallInternals({ spawn: stubSpawn('', 'ERR_PNPM_LOCKFILE_MISMATCH', 1) })
  process.env.DSH_RESTART_PROFILE = 'web5'
  try {
    const res = fakeRes()
    await routes['/dsh-restart/reinstall'].handler(fakeReq('POST', local, '/dsh-restart/reinstall', { name: 'plugin-b' }), res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.relink.attempted, true)
    assert.equal(body.relink.ok, false)
    assert.match(body.relink.error, /LOCKFILE/)
  } finally {
    delete process.env.DSH_RESTART_PROFILE
    mod._resetGitInternals()
    mod._resetInstallInternals()
  }
}

// ---- helpers ------------------------------------------------------------------
assert.equal(mod.dshPortFromArgs(['node', 'dsh', 'web', '--port', '3999']), 3999)
assert.equal(mod.dshPortFromArgs(['node', 'dsh', 'web', '--port=4100']), 4100)
assert.equal(mod.dshPortFromArgs(['node', 'dsh', 'web']), 3080)
assert.equal(mod.shellQuote("a'b"), "'a'\\''b'")

rmSync(tmp, { recursive: true, force: true })
console.log('host: state, toggle, restart (stubbed spawn/exit), community install (stubbed), git refs + checkout + uninstall + reinstall (stubbed), trust guard, helpers — ok')
