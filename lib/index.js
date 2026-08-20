/**
 * dsh-restart host half.
 *
 * Adds a "Restart" section to the DeepSeek Harness web GUI's Settings. This
 * half owns three concerns:
 *
 *   1. A self-restart route that respawns the dsh web process this plugin
 *      runs inside (the same restart the dsh-community-plugins tab offers,
 *      but with port-polling handoff so a slow-shutting-down old process
 *      cannot make the new one die with EADDRINUSE).
 *   2. A state route that lists the profile's installed third-party plugins
 *      (enabled/disabled) and whether dsh-community-plugins is available.
 *   3. A toggle route that mounts/unmounts an installed plugin by adding or
 *      removing its name from the profile's dsh.profile.bundles.
 *
 *   GET  /dsh-restart/state   -> { profile, plugins: [{name,spec,repo,enabled}],
 *                                  community: { installed, enabled, repo } }
 *   POST /dsh-restart/plugin  -> body { name, enabled } ; bundle membership
 *   POST /dsh-restart/community -> installs github:dujar/dsh-community-plugin
 *   GET  /dsh-restart/git-refs  -> ?name=<plugin> ; branch + remote refs of a
 *                                  local checkout (no network)
 *   POST /dsh-restart/git-checkout -> body { name, branch, remote } ; switches
 *                                  the checkout to the branch
 *   POST /dsh-restart/uninstall  -> body { name } ; removes the plugin from
 *                                  bundles + dependencies
 *   POST /dsh-restart/reinstall  -> body { name, remote } ; fresh-cleans a
 *                                  local checkout (local or its own remote)
 *   POST /dsh-restart         -> respawns this dsh web process
 *
 * The profile is auto-detected as the one whose bundle list contains this
 * package; DSH_RESTART_PROFILE (then DSH_PROFILE) overrides, and "web" is the
 * last-resort default. The restarter re-execs the exact command line this
 * process was launched with; DSH_RESTART_CMD overrides it (e.g.
 * "systemctl restart dsh-web" for supervised setups).
 *
 * Routes are guarded by the same fail-closed same-origin/localhost trust
 * check as dsh-trader and dsh-community-plugins: a cross-origin or malformed
 * Origin/Referer rejects, a CORS-simple content type rejects, and only then
 * does a localhost Host count as trusted.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

export const name = 'restart'

/** Package name used to detect which profile mounted this plugin. */
const NAME = 'dsh-restart'

/**
 * Package names that provide the community-plugins UI. The published repo is
 * dujar/dsh-community-plugin; the local dev checkout (dsh-community-plugins)
 * is still recognized so existing installs keep working.
 */
const COMMUNITY_PACKAGES = ['dsh-community-plugins', 'dsh-community-plugin']

/** GitHub repo advertised/installed by the "More plugins" card. */
export const COMMUNITY_REPO = 'dujar/dsh-community-plugin'

/** Host services required before mounting. */
export const inject = ['webServer']

/** How long a dsh web restart route waits before exiting, in ms. */
const EXIT_DELAY_MS = (() => {
  const value = Number(process.env.DSH_RESTART_EXIT_DELAY_MS)
  return Number.isFinite(value) && value >= 0 ? value : 400
})()

/** Maximum time the restart helper waits for the port to free, in ms. */
const PORT_WAIT_MS = 20 * 1000

/** Test seam: injected spawn / process-exit for the restart scheduler. */
let restartInternals = {}
export function _setRestartInternals(value) {
  restartInternals = value || {}
}
export function _resetRestartInternals() {
  restartInternals = {}
}

/** Test seam: injected spawn for the community install route. */
let installInternals = {}
export function _setInstallInternals(value) {
  installInternals = value || {}
}
export function _resetInstallInternals() {
  installInternals = {}
}

/** Test seam: injected spawn for the git checkout route. */
let gitInternals = {}
export function _setGitInternals(value) {
  gitInternals = value || {}
}
export function _resetGitInternals() {
  gitInternals = {}
}

// ---------------------------------------------------------------------------
// Profile helpers
// ---------------------------------------------------------------------------

/** Resolve the harness home the way dsh-home-paths does: $DSH_HOME, else ~/.dsh. */
export function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env
  return join(homedir(), '.dsh')
}

/** Read and parse a profile's package.json, or null when unavailable. */
export async function readProfileManifest(profile) {
  try {
    const raw = await readFile(join(dshHome(), 'profiles', profile, 'package.json'), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Find the profile whose bundle list includes this plugin; null when none does. */
async function detectProfile() {
  let names = []
  try {
    names = await readdir(join(dshHome(), 'profiles'))
  } catch {
    return null
  }
  for (const candidate of names) {
    if (candidate.startsWith('.')) continue
    const manifest = await readProfileManifest(candidate)
    const bundles = manifest?.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(NAME)) return candidate
  }
  return null
}

/** Resolve the profile this plugin is mounted in. */
export async function resolveProfile() {
  const explicit = process.env.DSH_RESTART_PROFILE || process.env.DSH_PROFILE
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const detected = await detectProfile()
  return detected || 'web'
}

/** The trailing path segment of an owner/name reference. */
export function repoSlug(repo) {
  if (typeof repo !== 'string') return null
  const idx = repo.indexOf('/')
  return idx === -1 ? repo : repo.slice(idx + 1)
}

/**
 * Extract an "owner/name" GitHub reference from a package spec, or null when
 * the spec is not a GitHub repo (registry names, versions, file:/link:/npm:
 * specs all yield null).
 */
export function repoFromSpec(spec) {
  if (typeof spec !== 'string') return null
  const s = spec.trim()
  if (s === '') return null
  let m
  if ((m = /^github:([^#/]+[/][^#/]+)/.exec(s))) return m[1]
  if ((m = /^(?:git[+]|git:)?(?:(?:https?:[/][/]|ssh:[/][/])[^@/]*@?|git@)github[.]com[:/]([^/.#]+)[/]([^/.#]+)/.exec(s))) return m[1] + '/' + m[2]
  if ((m = /^https?:[/][/]github[.]com[/]([^/.#]+)[/]([^/.#]+?)(?:[.]git)?(?:#.*)?$/.exec(s))) return m[1] + '/' + m[2]
  if (!/^[a-z][a-z0-9+.-]*:/.test(s) && !s.startsWith('/') && !s.startsWith('.') && !s.startsWith('~')) {
    const bare = s.split('#')[0]
    if ((m = /^([A-Za-z0-9_.-]+)[/]([A-Za-z0-9_.-]+?)(?:[.]git)?$/.exec(bare))) return m[1] + '/' + m[2]
  }
  return null
}

/**
 * Every [remote "..."] section of a git config with its url. Exported for
 * tests.
 */
export function parseGitRemotes(config) {
  const remotes = []
  let current = null
  for (const line of config.split('\n')) {
    const section = /^\s*\[\s*remote\s+"([^"]+)"\s*\]\s*$/.exec(line)
    if (section) {
      current = { name: section[1], url: null }
      remotes.push(current)
      continue
    }
    if (current && current.url === null) {
      const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line)
      if (url) {
        current.url = url[1]
        current = null
      }
    }
  }
  return remotes.filter((remote) => remote.url !== null)
}

/**
 * The first [remote "..."] section of a git config and its url, if any.
 * Exported for tests.
 */
export function parseGitRemote(config) {
  return parseGitRemotes(config)[0] ?? null
}

/**
 * The [branch "<name>"] tracking section of a git config: which remote the
 * branch tracks and the upstream branch name, or null when untracked.
 */
export function parseGitTracked(config, branch) {
  if (typeof branch !== 'string' || branch === '') return null
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const section = new RegExp(`^\\s*\\[\\s*branch\\s+"${escaped}"\\s*\\]\\s*$`, 'm').exec(config)
  if (!section) return null
  const rest = config.slice(section.index)
  const nextSection = rest.search(/\n\s*\[/)
  const body = nextSection === -1 ? rest : rest.slice(0, nextSection)
  const remote = /^\s*remote\s*=\s*(.+?)\s*$/m.exec(body)
  if (!remote) return null
  const merge = /^\s*merge\s*=\s*refs\/heads\/(.+?)\s*$/m.exec(body)
  return { remote: remote[1], branch: merge ? merge[1] : null }
}

/**
 * Resolve the .git directory of a local checkout — plain repos use
 * <dir>/.git as a directory, worktrees point at their gitdir through a
 * ".git" file. Returns null when <dir> is not a git checkout.
 */
export async function resolveGitDir(dir) {
  let gitDir = join(dir, '.git')
  try {
    const entry = await stat(gitDir)
    if (!entry.isDirectory()) {
      const raw = await readFile(gitDir, 'utf8')
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(raw)
      if (!pointer) return null
      gitDir = pointer[1].trim()
    }
  } catch {
    return null
  }
  return gitDir
}

/**
 * List loose refs under a .git prefix (e.g. "refs/heads"), walking nested
 * directories, plus packed-refs fallback for archived branches.
 */
export async function listRefs(gitDir, prefix) {
  const names = []
  const base = join(gitDir, prefix)
  async function walk(dir, rel) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'HEAD') continue
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel ? rel + '/' + entry.name : entry.name)
      else names.push(rel ? rel + '/' + entry.name : entry.name)
    }
  }
  await walk(base, '')
  try {
    const packed = await readFile(join(gitDir, 'packed-refs'), 'utf8')
    for (const line of packed.split('\n')) {
      const ref = /^[0-9a-f]{40}\s+(\S+)$/.exec(line.trim())
      if (ref && ref[1].startsWith(prefix + '/')) {
        const name = ref[1].slice(prefix.length + 1)
        if (!names.includes(name)) names.push(name)
      }
    }
  } catch { /* no packed-refs */ }
  return names.sort()
}

/**
 * Detect git metadata of a local plugin checkout — current branch and the
 * first remote with its URL — by reading .git only (no network, no git
 * binary). Handles plain repos (.git directory) and worktrees (.git file
 * carrying a "gitdir:" pointer). Returns { git:false } when the directory is
 * not a git checkout. Exported for tests.
 */
export async function detectLocalGit(dir) {
  const gitDir = await resolveGitDir(dir)
  if (!gitDir) return { git: false }
  let branch = null
  try {
    const head = await readFile(join(gitDir, 'HEAD'), 'utf8')
    const ref = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head)
    branch = ref ? ref[1] : head.trim().slice(0, 12)
  } catch { /* detached or unreadable */ }
  let remoteName = null
  let remoteUrl = null
  try {
    const remote = parseGitRemote(await readFile(join(gitDir, 'config'), 'utf8'))
    if (remote) {
      remoteName = remote.name
      remoteUrl = remote.url
    }
  } catch { /* no config */ }
  return { git: true, branch, remoteName, remoteUrl }
}

/** Local-checkout metadata for link:/file: specs; null for anything else. */
async function localInfo(spec) {
  if (typeof spec !== 'string') return null
  if (!spec.startsWith('link:') && !spec.startsWith('file:')) return null
  const path = spec.slice(5)
  if (path === '') return null
  return Object.assign({ path }, await detectLocalGit(path))
}

/**
 * The installed out-of-tree plugins of one profile, as the union of the
 * non-shipped dsh.profile.bundles entries and the dependency manifest.
 */
export async function collectInstalled(profile) {
  const manifest = await readProfileManifest(profile)
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const deps = manifest !== null && typeof manifest.dependencies === 'object' && manifest.dependencies !== null
    ? manifest.dependencies
    : {}
  const plugins = []
  const seen = new Set()
  for (const name of bundles) {
    if (name.startsWith('@deepseek-ai/') || name.startsWith('cordis:') || name.startsWith('cordis-plugin-')) continue
    seen.add(name)
    const spec = deps[name] ?? null
    plugins.push({ name, spec, repo: repoFromSpec(spec), enabled: true, local: await localInfo(spec) })
  }
  for (const [name, spec] of Object.entries(deps)) {
    if (seen.has(name)) continue
    seen.add(name)
    plugins.push({ name, spec, repo: repoFromSpec(spec), enabled: false, local: await localInfo(spec) })
  }
  return plugins
}

/**
 * Add or remove a package name from the profile's dsh.profile.bundles list —
 * that membership is what mounts (or stops mounting) a plugin. Returns null
 * when the name is not actually installed in the profile.
 */
export async function setBundleEnabled(profile, name, enabled) {
  const path = join(dshHome(), 'profiles', profile, 'package.json')
  const raw = await readFile(path, 'utf8')
  const manifest = JSON.parse(raw)
  if (!manifest.dsh || typeof manifest.dsh !== 'object') manifest.dsh = {}
  if (!manifest.dsh.profile || typeof manifest.dsh.profile !== 'object') manifest.dsh.profile = {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  manifest.dsh.profile.bundles = bundles
  const idx = bundles.indexOf(name)
  if (enabled && idx === -1) bundles.push(name)
  if (!enabled && idx !== -1) bundles.splice(idx, 1)
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
  return true
}

/**
 * Fully uninstall a plugin: remove it from dsh.profile.bundles AND from
 * dependencies. Returns { bundles, deps } booleans describing what was
 * removed, or null when the name was not installed at all.
 */
export async function removePlugin(profile, name) {
  const path = join(dshHome(), 'profiles', profile, 'package.json')
  const raw = await readFile(path, 'utf8')
  const manifest = JSON.parse(raw)
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const deps = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  let changed = false
  const removed = { bundles: false, deps: false }
  const bidx = bundles.indexOf(name)
  if (bidx !== -1) {
    bundles.splice(bidx, 1)
    removed.bundles = true
    changed = true
  }
  if (Object.prototype.hasOwnProperty.call(deps, name)) {
    delete deps[name]
    removed.deps = true
    changed = true
  }
  if (!changed) return null
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
  return removed
}

// ---------------------------------------------------------------------------
// dsh web self-restart (port-polling handoff)
// ---------------------------------------------------------------------------

/** Shell-quote a single argument for sh -c. */
export function shellQuote(arg) {
  return "'" + String(arg).replace(/'/g, "'\\''") + "'"
}

/** Parse the dsh web port from the launch args (--port/-p, incl. --port=N). */
export function dshPortFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--port' || a === '-p') {
      const n = Number(args[i + 1])
      if (Number.isInteger(n) && n > 0 && n < 65536) return n
    } else if (a.startsWith('--port=')) {
      const n = Number(a.slice('--port='.length))
      if (Number.isInteger(n) && n > 0 && n < 65536) return n
    }
  }
  return 3080
}

/**
 * Node helper source for the detached restarter. It waits for the web port to
 * be released (up to PORT_WAIT_MS; a timeout still spawns, rather than leave
 * dsh down), then re-execs the exact launch command with stdio inherited so
 * the new instance keeps writing to the same terminal. Failures are appended
 * to a tmp log the operator can inspect.
 */
export function restarterHelperCode(command, port, logErr) {
  return [
    "const { spawn } = require('node:child_process')",
    "const net = require('node:net')",
    "const fs = require('node:fs')",
    `const command = ${JSON.stringify(command)}`,
    `const logErr = ${JSON.stringify(logErr)}`,
    `const port = ${port}`,
    'function portFree(p, cb) {',
    '  const s = net.connect(p, "127.0.0.1")',
    '  s.once("connect", () => { s.destroy(); cb(false) })',
    '  s.once("error", () => cb(true))',
    '}',
    'function waitPort(p, tries, cb) {',
    '  portFree(p, (free) => {',
    '    if (free || tries <= 0) cb(free)',
    '    else setTimeout(() => waitPort(p, tries - 1, cb), 200)',
    '  })',
    '}',
    `waitPort(port, ${Math.ceil(PORT_WAIT_MS / 200)}, () => {`,
    '  setTimeout(() => {',
    '    try {',
    "      const child = spawn('sh', ['-c', command], { detached: true, stdio: 'inherit', env: process.env })",
    '      child.unref()',
    '    } catch (ex) {',
    '      try { fs.appendFileSync(logErr, "restart failed: " + (ex && ex.message) + "\\n") } catch {}',
    '    }',
    '  }, 300)',
    '})',
  ].join('\n')
}

/**
 * Schedule a restart of the dsh web process this plugin runs inside.
 *
 * The restarter is spawned detached so it survives our own exit: it polls the
 * web port until it is released, then re-execs the exact command line this
 * process was launched with (node <dsh-bin> web ...) with inherited stdio.
 * DSH_RESTART_CMD overrides the re-exec — e.g. "systemctl restart dsh-web"
 * for supervised setups.
 */
export function scheduleDshWebRestart() {
  const custom = process.env.DSH_RESTART_CMD
  const command = typeof custom === 'string' && custom.trim() !== ''
    ? custom.trim()
    : shellQuote(process.execPath) + ' ' + process.argv.slice(1).map(shellQuote).join(' ')
  const port = dshPortFromArgs(process.argv)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logErr = join(tmpdir(), `dsh-restart-${stamp}.err.log`)
  const spawnFn = restartInternals.spawn ?? spawn
  try {
    const child = spawnFn(process.execPath, ['-e', restarterHelperCode(command, port, logErr)], {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: 'inherit',
    })
    child.unref?.()
    child.on?.('error', () => {})
    return { ok: true, helperPid: child.pid ?? null }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
}

// ---------------------------------------------------------------------------
// Community plugins install (advertised repo dujar/dsh-community-plugin)
// ---------------------------------------------------------------------------

/**
 * Install the advertised community plugin into a profile by running
 * `dsh plugin --profile <p> add github:dujar/dsh-community-plugin` (pnpm
 * under the hood). DSH_BIN overrides the dsh executable (fallback: `dsh` on
 * PATH). Resolves with the captured output; ok:false carries the exit code
 * and stderr so the UI can show why it failed (e.g. repo not published yet).
 */
export function installCommunity(profile) {
  return new Promise((resolve) => {
    const bin = process.env.DSH_BIN || 'dsh'
    const args = ['plugin', '--profile', profile, 'add', 'github:' + COMMUNITY_REPO]
    const spawnFn = installInternals.spawn ?? spawn
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawnFn(bin, args, { cwd: process.cwd(), env: process.env })
    } catch (error) {
      resolve({ ok: false, error: String(error && error.message ? error.message : error) })
      return
    }
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => resolve({ ok: false, error: String(error.message || error) }))
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, output: stdout.trim() || stderr.trim() })
      else resolve({ ok: false, code, error: stderr.trim() || stdout.trim() || `exit code ${code}` })
    })
  })
}

// ---------------------------------------------------------------------------
// Git branch switching for local plugin checkouts
// ---------------------------------------------------------------------------

/** Package-name prefixes of harness-shipped builtins that cannot be uninstalled. */
const BUILTIN_PREFIXES = ['@deepseek-ai/', 'cordis:', 'cordis-plugin-']

function errorMessage(error) {
  return String(error && error.message ? error.message : error)
}

/** Branch names must stay option-like: no leading dash, safe charset. */
const BRANCH_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.\/-]*$/

/** Run `git <args>` with the injectable spawn seam; resolves with output. */
function runGit(args) {
  return new Promise((resolve) => {
    const bin = process.env.GIT_BIN || 'git'
    const spawnFn = gitInternals.spawn ?? spawn
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawnFn(bin, args, { cwd: process.cwd(), env: process.env })
    } catch (error) {
      resolve({ ok: false, error: String(error && error.message ? error.message : error) })
      return
    }
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => resolve({ ok: false, error: String(error.message || error) }))
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, output: stdout.trim() || stderr.trim() })
      else resolve({ ok: false, code, error: stderr.trim() || stdout.trim() || `exit code ${code}` })
    })
  })
}

/** Local checkout path of an installed plugin, or null when not link:/file:. */
async function localPathOf(profile, name) {
  const manifest = await readProfileManifest(profile)
  const spec = manifest?.dependencies?.[name]
  if (typeof spec !== 'string' || !spec.startsWith('link:') && !spec.startsWith('file:')) return null
  return spec.slice(5)
}

/**
 * The branch + remote refs of a local plugin checkout, read from .git only
 * (no network, no git binary): local branches, every remote with its
 * remote-tracking branches, and the upstream the current branch tracks.
 */
export async function collectGitRefs(path) {
  const gitDir = await resolveGitDir(path)
  if (!gitDir) return { ok: false, error: 'not a git checkout: ' + path }
  const head = await (async () => {
    try {
      const raw = await readFile(join(gitDir, 'HEAD'), 'utf8')
      const ref = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(raw)
      return ref ? ref[1] : raw.trim().slice(0, 12)
    } catch {
      return null
    }
  })()
  const local = await listRefs(gitDir, 'refs/heads')
  const remoteRefs = await listRefs(gitDir, 'refs/remotes')
  let config = ''
  try {
    config = await readFile(join(gitDir, 'config'), 'utf8')
  } catch { /* no config */ }
  const remotes = parseGitRemotes(config).map((remote) => ({
    name: remote.name,
    url: remote.url,
    branches: remoteRefs.filter((ref) => ref.startsWith(remote.name + '/'))
      .map((ref) => ref.slice(remote.name.length + 1)),
  }))
  return {
    ok: true,
    path,
    head,
    local,
    remotes,
    tracked: parseGitTracked(config, head),
  }
}

/**
 * Switch a local plugin checkout to a branch, repo-aware:
 *
 * - remote selected, branch not present locally : `git checkout -b <b> <r>/<b>`
 *   (new local branch tracking that remote)
 * - remote selected, branch present locally, not the current head : plain
 *   `git checkout <b>`
 * - remote selected, branch IS the current head : retarget the upstream with
 *   `git branch --set-upstream-to <r>/<b> <b>` — this is what makes "same
 *   branch, different repo" (e.g. local → origin → upstream) actually switch;
 *   it keeps local commits intact. Already tracking that remote is a no-op.
 * - local repo, branch is the current head : `git branch --unset-upstream`
 *   (back to a plain local branch), unless it already is one.
 * - local repo, other branch : plain `git checkout <b>`.
 *
 * Only refs already present locally are used — no network.
 */
export async function gitCheckout(path, branch, remote) {
  if (typeof branch !== 'string' || !BRANCH_RE.test(branch)) {
    return { ok: false, invalid: true, error: 'invalid branch name: ' + String(branch) }
  }
  const gitDir = await resolveGitDir(path)
  if (!gitDir) return { ok: false, missing: true, error: 'not a git checkout: ' + path }
  const config = await readFile(join(gitDir, 'config'), 'utf8').catch(() => '')
  const head = await (async () => {
    try {
      const raw = await readFile(join(gitDir, 'HEAD'), 'utf8')
      const ref = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(raw)
      return ref ? ref[1] : null
    } catch {
      return null
    }
  })()
  let args
  let noop = false
  if (typeof remote === 'string' && remote !== '' && BRANCH_RE.test(remote)) {
    const local = await listRefs(gitDir, 'refs/heads')
    if (local.includes(branch)) {
      if (branch === head) {
        const tracked = parseGitTracked(config, branch)
        if (tracked && tracked.remote === remote) noop = true
        else args = ['-C', path, 'branch', '--set-upstream-to', remote + '/' + branch, branch]
      } else {
        args = ['-C', path, 'checkout', branch]
      }
    } else {
      args = ['-C', path, 'checkout', '-b', branch, remote + '/' + branch]
    }
  } else {
    if (branch === head) {
      const tracked = parseGitTracked(config, branch)
      if (!tracked) noop = true
      else args = ['-C', path, 'branch', '--unset-upstream', branch]
    } else {
      args = ['-C', path, 'checkout', branch]
    }
  }
  if (noop) return { ok: true, noop: true, branch, output: 'already on ' + (typeof remote === 'string' && remote !== '' ? remote + '/' : '') + branch }
  const result = await runGit(args)
  return Object.assign({ branch, args }, result)
}

/**
 * The default branch of a remote as seen locally: refs/remotes/<r>/HEAD when
 * present, else main, else master, else the first remote-tracking branch.
 */
async function defaultRemoteBranch(gitDir, remote) {
  try {
    const head = await readFile(join(gitDir, 'refs', 'remotes', remote, 'HEAD'), 'utf8')
    const m = /^ref:\s*refs\/remotes\/[^/]+\/(.+?)\s*$/m.exec(head)
    if (m) return m[1]
  } catch { /* no remote HEAD */ }
  const branches = await listRefs(gitDir, 'refs/remotes/' + remote)
  for (const preferred of ['main', 'master']) if (branches.includes(preferred)) return preferred
  return branches[0] || null
}

/**
 * Fresh-clean a local plugin checkout — the "reinstall":
 * - source 'local' (remote == null)  : `git reset --hard` + `git clean -fdx`
 *   (discard every local change, untracked files included; back to HEAD)
 * - source <remote>                  : fetch the remote, hard-reset the
 *   checkout to its default branch and clean — a pristine copy of the repo
 *   as published upstream.
 * Any failing step aborts with its stderr. Returns { ok, output } or
 * { ok:false, ... }.
 */
export async function reinstallGitCheckout(path, remote) {
  const gitDir = await resolveGitDir(path)
  if (!gitDir) return { ok: false, missing: true, error: 'not a git checkout: ' + path }
  const steps = []
  if (remote) {
    const config = await readFile(join(gitDir, 'config'), 'utf8').catch(() => '')
    if (!parseGitRemotes(config).some((r) => r.name === remote)) {
      return { ok: false, invalid: true, error: 'no such remote: ' + remote }
    }
    const branch = await defaultRemoteBranch(gitDir, remote)
    if (!branch) return { ok: false, error: 'no branches on remote ' + remote }
    steps.push(
      ['fetch', remote],
      ['reset', '--hard', remote + '/' + branch],
      ['checkout', '-B', branch],
      ['clean', '-fdx'],
    )
  } else {
    steps.push(['reset', '--hard'], ['clean', '-fdx'])
  }
  const outputs = []
  for (const args of steps) {
    const result = await runGit(['-C', path].concat(args))
    if (!result.ok) return { ok: false, code: result.code, error: result.error, step: args[0] }
    if (result.output) outputs.push(result.output)
  }
  return { ok: true, output: outputs.join('\n') }
}

// ---------------------------------------------------------------------------
// HTTP helpers (trust check mirroring dsh-trader / dsh-community-plugins)
// ---------------------------------------------------------------------------

function headerHost(value) {
  try {
    return new URL(value).host
  } catch {
    return null
  }
}

function simpleContentType(value) {
  if (typeof value !== 'string' || value === '') return false
  const type = value.split(';')[0].trim().toLowerCase()
  return type === 'text/plain' || type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data'
}

function isTrustedRequest(req) {
  const headers = req.headers ?? {}
  const host = headers.host ?? ''
  for (const header of [headers.origin, headers.referer]) {
    if (header === undefined || header === null || header === '') continue
    if (header === 'null') return false
    const sourceHost = headerHost(header)
    if (sourceHost === null || sourceHost !== host) return false
  }
  if (simpleContentType(headers['content-type'])) return false
  return host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('::1')
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export async function apply(ctx) {
  // GET /dsh-restart/state — profile, installed plugins and community status.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart/state',
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'untrusted request' })
      try {
        const profile = await resolveProfile()
        const manifest = await readProfileManifest(profile)
        const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
        const deps = manifest !== null && typeof manifest.dependencies === 'object' && manifest.dependencies !== null
          ? manifest.dependencies
          : {}
        const communityInstalled = COMMUNITY_PACKAGES.some((candidate) => Object.prototype.hasOwnProperty.call(deps, candidate))
        const communityEnabled = COMMUNITY_PACKAGES.some((candidate) => bundles.includes(candidate))
        sendJson(res, 200, {
          profile,
          plugins: await collectInstalled(profile),
          community: {
            installed: communityInstalled,
            enabled: communityEnabled,
            repo: COMMUNITY_REPO,
          },
        })
      } catch (error) {
        sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
      }
    },
  }), 'dsh-restart: /dsh-restart/state route')

  // POST /dsh-restart/plugin — enable/disable an installed plugin by adding
  // or removing its name from dsh.profile.bundles. The change shows up
  // immediately in this section; the harness loads it after a restart.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart/plugin',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'untrusted request' })
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        return sendJson(res, 400, { error: 'invalid body' })
      }
      const name = typeof body?.name === 'string' ? body.name.trim() : ''
      const enabled = !!body?.enabled
      if (name === '' || name.length > 200) return sendJson(res, 400, { error: 'name must be a package name' })
      try {
        const profile = await resolveProfile()
        const plugins = await collectInstalled(profile)
        const plugin = plugins.find((candidate) => candidate.name === name)
        if (!plugin) return sendJson(res, 400, { error: 'no installed plugin named ' + name })
        const changed = await setBundleEnabled(profile, name, enabled)
        sendJson(res, changed ? 200 : 400, {
          ok: changed,
          profile,
          name,
          enabled,
          already: plugin.enabled === enabled,
          needsRestart: changed,
        })
      } catch (error) {
        sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
      }
    },
  }), 'dsh-restart: /dsh-restart/plugin route')

  // POST /dsh-restart/community — one-click install of the advertised
  // community plugin (github:dujar/dsh-community-plugin) into the profile.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart/community',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'untrusted request' })
      try {
        const profile = await resolveProfile()
        const result = await installCommunity(profile)
        sendJson(res, result.ok ? 200 : 500, { ok: result.ok, profile, ...result })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
    },
  }), 'dsh-restart: /dsh-restart/community route')

  // GET /dsh-restart/git-refs — branch + remote refs of a local plugin checkout.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart/git-refs',
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'untrusted request' })
      try {
        const url = new URL(req.url, 'http://localhost')
        const name = url.searchParams.get('name')
        if (!name) return sendJson(res, 400, { error: 'missing name' })
        const profile = await resolveProfile()
        const path = await localPathOf(profile, name)
        if (!path) return sendJson(res, 404, { ok: false, error: 'not a local plugin: ' + name })
        const refs = await collectGitRefs(path)
        if (!refs.ok) return sendJson(res, 404, refs)
        sendJson(res, 200, refs)
      } catch (error) {
        sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
      }
    },
  }))

  // POST /dsh-restart/git-checkout — switch a local plugin checkout to a branch.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart/git-checkout',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'untrusted request' })
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        return sendJson(res, 400, { error: 'invalid body' })
      }
      const name = typeof body.name === 'string' ? body.name : ''
      const branch = typeof body.branch === 'string' ? body.branch : ''
      const remote = typeof body.remote === 'string' ? body.remote : ''
      if (name === '' || branch === '') return sendJson(res, 400, { error: 'name and branch required' })
      try {
        const profile = await resolveProfile()
        const path = await localPathOf(profile, name)
        if (!path) return sendJson(res, 404, { ok: false, error: 'not a local plugin: ' + name })
        const result = await gitCheckout(path, branch, remote)
        if (result.ok) sendJson(res, 200, { ok: true, branch, output: result.output, ...(result.noop ? { noop: true } : {}) })
        else if (result.invalid) sendJson(res, 400, { ok: false, branch, error: result.error })
        else if (result.missing) sendJson(res, 404, { ok: false, branch, error: result.error })
        else sendJson(res, 500, { ok: false, branch, error: result.error })
      } catch (error) {
        sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
      }
    },
  }))

  // POST /dsh-restart/uninstall — remove a plugin from bundles + dependencies.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart/uninstall',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'forbidden' })
      const body = await readJsonBody(req).catch(() => null)
      const name = body && typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) return sendJson(res, 400, { error: 'name required' })
      if (BUILTIN_PREFIXES.some((p) => name.startsWith(p))) {
        return sendJson(res, 400, { error: 'cannot uninstall a builtin: ' + name })
      }
      try {
        const profile = await resolveProfile()
        const removed = await removePlugin(profile, name)
        if (!removed) return sendJson(res, 404, { ok: false, error: 'not installed: ' + name })
        sendJson(res, 200, { ok: true, name, removed })
      } catch (error) {
        sendJson(res, 500, { error: 'uninstall failed: ' + errorMessage(error) })
      }
    },
  }))

  // POST /dsh-restart/reinstall — fresh-clean a local plugin checkout.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart/reinstall',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'forbidden' })
      const body = await readJsonBody(req).catch(() => null)
      const name = body && typeof body.name === 'string' ? body.name.trim() : ''
      const remote = body && typeof body.remote === 'string' && body.remote.trim() !== '' ? body.remote.trim() : null
      if (!name) return sendJson(res, 400, { error: 'name required' })
      try {
        const profile = await resolveProfile()
        const path = await localPathOf(profile, name)
        if (!path) return sendJson(res, 404, { ok: false, error: 'not a local plugin: ' + name })
        const result = await reinstallGitCheckout(path, remote)
        if (result.ok) sendJson(res, 200, { ok: true, name, remote, output: result.output })
        else if (result.invalid) sendJson(res, 400, { ok: false, error: result.error })
        else if (result.missing) sendJson(res, 404, { ok: false, error: result.error })
        else sendJson(res, 500, { ok: false, error: result.error, step: result.step })
      } catch (error) {
        sendJson(res, 500, { error: 'reinstall failed: ' + errorMessage(error) })
      }
    },
  }))

  // POST /dsh-restart — respawn this dsh web instance with the same command
  // line, then exit once the response has flushed.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'untrusted request' })
      const result = scheduleDshWebRestart()
      sendJson(res, result.ok ? 200 : 500, { ok: result.ok, restarting: result.ok, error: result.error })
      if (result.ok) {
        // Give the response time to reach the browser, then release the port.
        setTimeout(() => {
          const exit = restartInternals.exit ?? process.exit
          exit(0)
        }, EXIT_DELAY_MS)
      }
    },
  }), 'dsh-restart: /dsh-restart route')

  console.log('[dsh-restart] host routes ready')
}
