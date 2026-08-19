// Read-only live check: resolve the real profile and list its installed
// plugins exactly as the /dsh-restart/state route would. Never writes.
import { resolveProfile, collectInstalled } from '../lib/index.js'

const profile = await resolveProfile()
const plugins = await collectInstalled(profile)
console.log('profile:', profile)
console.log('plugins:')
for (const p of plugins) console.log('  -', p.name, p.enabled ? '[enabled]' : '[disabled]', p.repo ? '(' + p.repo + ')' : '')
