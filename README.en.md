# dsh-restart

A DeepSeek Harness plugin that adds a **Settings → Restart** section: restart
dsh web in one click, toggle installed plugins on/off, and jump to the
Community plugins tab to install more. Bilingual UI (follows the host's global
language, zh / en).

## Features

- **Restart dsh web** — one button restarts the host web process. The
  restarter is a detached helper that polls until the port is actually
  released (up to 20s) before relaunching, so a slow-shutting-down old
  process cannot make the new one die with EADDRINUSE; the new instance
  inherits the original terminal's stdio. Environment overrides:
  - `DSH_RESTART_CMD` — custom restart command (e.g. `systemctl restart
    dsh-web`); defaults to re-executing the original launch command line.
  - `DSH_RESTART_PROFILE` / `DSH_PROFILE` — explicit profile; by default the
    profile that mounted this plugin is auto-detected (fallback `web`).
- **Enable/disable installed plugins** — lists every third-party plugin of
  the active profile (union of `dsh.profile.bundles` and `dependencies`,
  excluding `@deepseek-ai/*` and `cordis:*` built-ins) with a toggle per
  plugin that edits the profile's `package.json`; changes apply after a
  restart. Rows with a pending change show a "Restart to apply" chip.
- **More plugins** — when dsh-community-plugins is installed and enabled, a
  button jumps straight to **Settings → Plugins → Community plugins**;
  otherwise guidance plus the GitHub dsh-plugin topic link.

## Install

```sh
dsh plugin --profile web add /path/to/dsh-restart
# then add "dsh-restart" to dsh.profile.bundles in
# ~/.dsh/profiles/web/package.json
```

After restarting dsh web, a "Restart" section appears at the bottom of the
Settings sidebar.

## Host routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/dsh-restart/state` | profile, installed plugins (with enabled state), dsh-community-plugins availability |
| POST | `/dsh-restart/plugin` | `{ name, enabled }` — add/remove a `dsh.profile.bundles` entry |
| POST | `/dsh-restart` | schedule a self-restart; the process exits ~400ms after the response |

All routes use the fail-closed same-origin/localhost trust check shared with
dsh-trader and dsh-community-plugins.

## Development

Zero-build plugin (same pattern as dsh-community-plugins /
dsh-better-archive):

```sh
npm test          # host routes + client contract/dict balance + real-React SSR
node --check lib/index.js && node --check lib/client.js
```

- Client: `lib/client.js` (CJS factory + ModuleLoader; React comes from the host).
- Host: `lib/index.js` (`ctx.webServer.register` mounts the routes).
- i18n: `ctx.locale.register('restart', { zh, en })` — the host enforces zh/en
  key parity, so every new string must land in both dictionaries.

## License

MIT
