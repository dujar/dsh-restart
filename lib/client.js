// dsh-restart browser half.
//
// Zero-build hand-written client bundle (same pattern as dsh-community-plugins
// and dsh-better-archive): a CJS factory wrapped in the ModuleLoader call.
// React comes from require("react"). The plugin registers a "Restart" section
// into the Settings sidebar's "settings.section" list slot (order 100, the
// last section) with three cards:
//
//   1. Restart dsh web   — one-click restart of the host web process
//      (port-polling handoff; the page reloads once the server is back).
//   2. Installed plugins — every third-party plugin of the active profile
//      with an enable/disable switch; toggles edit dsh.profile.bundles and
//      take effect after a restart.
//   3. More plugins      — when dsh-community-plugins is installed and
//      enabled, an in-app jump to Settings → Plugins → Community plugins;
//      otherwise guidance plus the GitHub dsh-plugin topic link.
//
// All reads go through GET /dsh-restart/state; writes through
// POST /dsh-restart/plugin and POST /dsh-restart. The section re-reads state
// on mount and when the tab becomes visible again (so an external install or
// a language switch is picked up), and after every mutation.
window.__ModuleLoader__.load({
  id: 'dsh-restart',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var createElement = React.createElement

    // -----------------------------------------------------------------------
    // Styles (injected once, guarded for HMR). Theme-aware: every color is a
    // --dsw-alias-* variable so light/dark themes are followed automatically.
    // -----------------------------------------------------------------------
    if (typeof document !== 'undefined' && !document.querySelector('style[data-dshrt-styles]')) {
      var style = document.createElement('style')
      style.setAttribute('data-dshrt-styles', '1')
      style.textContent = [
        '.dshrt-root{max-width:560px;display:flex;flex-direction:column;gap:14px;font-family:inherit}',
        '.dshrt-title{margin:0;font-size:17px;font-weight:650;color:var(--dsw-alias-label-primary)}',
        '.dshrt-subtitle{margin:2px 0 0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
        '.dshrt-cards{display:flex;flex-direction:column;gap:12px}',
        '.dshrt-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}',
        '.dshrt-card-head{display:flex;flex-direction:column;gap:2px}',
        '.dshrt-card-title{margin:0;font-size:13.5px;font-weight:650;color:var(--dsw-alias-label-primary)}',
        '.dshrt-card-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
        '.dshrt-card-body{display:flex;flex-direction:column;gap:10px}',
        '.dshrt-restart-body{flex-direction:row;align-items:center;gap:12px;flex-wrap:wrap}',
        '.dshrt-primary{border:none;border-radius:8px;padding:9px 18px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;background:var(--dsw-alias-state-business-primary);color:#fff;transition:filter .15s ease,transform .06s ease}',
        '.dshrt-primary:hover:not(:disabled){filter:brightness(1.08)}',
        '.dshrt-primary:active:not(:disabled){transform:translateY(1px)}',
        '.dshrt-primary:disabled{opacity:.55;cursor:default}',
        '.dshrt-primary:focus-visible,.dshrt-secondary:focus-visible,.dshrt-ghost:focus-visible,.dshrt-mini:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
        '.dshrt-secondary{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;align-self:flex-start;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);transition:background .15s ease,transform .06s ease}',
        '.dshrt-secondary:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dshrt-secondary:active{transform:translateY(1px)}',
        '.dshrt-meta{font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
        '.dshrt-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 2px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
        '.dshrt-row:last-child{border-bottom:none;padding-bottom:2px}',
        '.dshrt-row-main{display:flex;flex-direction:column;gap:4px;min-width:0}',
        '.dshrt-row-name{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
        '.dshrt-row-name>span{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);word-break:break-all}',
        '.dshrt-row-repo{font-size:11px;color:var(--dsw-alias-label-tertiary);text-decoration:none;white-space:nowrap}',
        '.dshrt-row-repo:hover{color:var(--dsw-alias-state-business-primary);text-decoration:underline}',
        '.dshrt-row-meta{display:flex;align-items:center;gap:8px}',
        '.dshrt-badge{font-size:10.5px;font-weight:600;line-height:1;padding:3px 8px;border-radius:999px}',
        '.dshrt-badge-on{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}',
        '.dshrt-badge-off{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary)}',
        '.dshrt-chip{font-size:10.5px;font-weight:600;line-height:1;padding:3px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-state-warn-primary)}',
        '.dshrt-toggle{position:relative;width:34px;height:18px;border-radius:999px;border:none;padding:0;cursor:pointer;flex:none;background:var(--dsw-alias-bg-layer-3);transition:background .15s ease}',
        '.dshrt-toggle-on{background:var(--dsw-alias-state-business-primary)}',
        '.dshrt-toggle:disabled{opacity:.55;cursor:default}',
        '.dshrt-toggle-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 25%,transparent);transition:transform .15s ease}',
        '.dshrt-toggle-on .dshrt-toggle-knob{transform:translateX(16px)}',
        '.dshrt-notice{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;border-radius:8px;padding:10px 12px;font-size:12.5px;line-height:1.5}',
        '.dshrt-notice-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-label-primary)}',
        '.dshrt-notice-err{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-label-primary)}',
        '.dshrt-notice-main{display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.dshrt-notice-detail{color:var(--dsw-alias-label-secondary);word-break:break-all;white-space:pre-wrap}',
        '.dshrt-mini{border:none;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;flex:none;background:var(--dsw-alias-state-business-primary);color:#fff}',
        '.dshrt-ghost{background:transparent;color:var(--dsw-alias-label-tertiary);font-size:14px;padding:0 2px;line-height:1}',
        '.dshrt-ghost:hover{color:var(--dsw-alias-label-primary)}',
        '.dshrt-footnote{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
        '.dshrt-link{font-size:12px;color:var(--dsw-alias-state-business-primary);text-decoration:none}',
        '.dshrt-link:hover{text-decoration:underline}',
        '.dshrt-empty{padding:8px 2px;font-size:12.5px;color:var(--dsw-alias-label-tertiary)}',
        '.dshrt-error{display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--dsw-alias-state-error-primary)}',
        '.dshrt-sk{height:34px;border-radius:8px;background:linear-gradient(100deg,var(--dsw-alias-bg-layer-2) 40%,var(--dsw-alias-interactive-bg-hover) 50%,var(--dsw-alias-bg-layer-2) 60%);background-size:200% 100%;animation:dshrtShimmer 1.2s ease-in-out infinite}',
        '@keyframes dshrtShimmer{to{background-position:-200% 0}}',
        '@media (prefers-reduced-motion:reduce){.dshrt-primary,.dshrt-secondary,.dshrt-toggle,.dshrt-toggle-knob{transition:none}.dshrt-sk{animation:none}}',
      ].join('')
      document.head.appendChild(style)
    }

    // -----------------------------------------------------------------------
    // i18n. The host locale service enforces zh/en key parity; every key below
    // exists in BOTH dicts.
    // -----------------------------------------------------------------------
    var NS = 'restart'

    var STRINGS = {
      en: {
        sectionLabel: 'Restart',
        sectionHint: 'Restart the dsh web process and manage installed plugins.',
        restartCardTitle: 'Restart dsh web',
        restartCardHint: 'Applies pending plugin changes. The current page reloads once the server is back.',
        restartButton: 'Restart now',
        restarting: 'Restarting…',
        restartStarted: 'Restarting dsh web — the page will reload in a few seconds.',
        restartFailed: 'Could not schedule the restart.',
        profile: 'Profile',
        pluginsCardTitle: 'Installed plugins',
        pluginsCardHint: 'Toggle a plugin to mount or unmount it. The change applies after a restart.',
        noPlugins: 'No third-party plugins installed in this profile.',
        loading: 'Loading…',
        error: 'Could not read the restart state.',
        retry: 'Retry',
        enabled: 'Enabled',
        disabled: 'Disabled',
        restartToApply: 'Restart to apply',
        pluginEnabledOk: 'Enabled. Restart dsh web to activate it.',
        pluginDisabledOk: 'Disabled. Restart dsh web to apply.',
        pluginToggleFailed: 'Could not update the plugin.',
        moreCardTitle: 'More plugins',
        moreCardHint: 'Find and install more plugins from the community.',
        browseMore: 'Browse more plugins',
        browseMoreHint: 'Opens the Community plugins tab under Settings → Plugins.',
        communityDisabledHint: 'dsh-community-plugins is installed but disabled. Enable it above, restart, then browse more plugins.',
        communityMissingHint: 'dsh-community-plugins is not installed. Install it to browse and install plugins from GitHub.',
        openGithub: 'Open the dsh-plugin topic on GitHub',
        dismiss: 'Dismiss',
      },
      zh: {
        sectionLabel: '重启',
        sectionHint: '重启 dsh web 进程并管理已安装插件。',
        restartCardTitle: '重启 dsh web',
        restartCardHint: '应用待生效的插件更改。服务恢复后当前页面会自动重新加载。',
        restartButton: '立即重启',
        restarting: '重启中…',
        restartStarted: '正在重启 dsh web——几秒后页面将重新加载。',
        restartFailed: '无法安排重启。',
        profile: '配置文件',
        pluginsCardTitle: '已安装插件',
        pluginsCardHint: '开关插件以挂载或卸载，更改在重启后生效。',
        noPlugins: '此配置文件未安装第三方插件。',
        loading: '加载中…',
        error: '读取重启状态失败。',
        retry: '重试',
        enabled: '已启用',
        disabled: '已禁用',
        restartToApply: '重启后生效',
        pluginEnabledOk: '已启用。重启 dsh web 后生效。',
        pluginDisabledOk: '已禁用。重启 dsh web 后生效。',
        pluginToggleFailed: '无法更新插件。',
        moreCardTitle: '更多插件',
        moreCardHint: '从社区发现并安装更多插件。',
        browseMore: '浏览更多插件',
        browseMoreHint: '打开 设置 → 插件 下的“社区插件”页。',
        communityDisabledHint: 'dsh-community-plugins 已安装但未启用。请先在上方启用并重启，再浏览更多插件。',
        communityMissingHint: '未安装 dsh-community-plugins。安装后即可从 GitHub 浏览并安装插件。',
        openGithub: '在 GitHub 打开 dsh-plugin 主题',
        dismiss: '关闭',
      },
    }

    /** Local fallback translator for when the host locale service is absent. */
    function makeT(dicts, lang) {
      var dict = dicts[lang] || dicts.en
      return function (key) {
        return dict[key] !== undefined ? dict[key] : key
      }
    }

    function resolveBrowserLocale() {
      try {
        var lang = String(navigator.language || 'en').toLowerCase()
        return lang.startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }

    // -----------------------------------------------------------------------
    // API face
    // -----------------------------------------------------------------------
    function parseJson(response) {
      return response.json().catch(function () { return { ok: false, error: 'bad response' } })
    }

    function postJson(path, body) {
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(parseJson)
    }

    var face = {
      state: function () { return fetch('/dsh-restart/state').then(parseJson) },
      setEnabled: function (name, enabled) { return postJson('/dsh-restart/plugin', { name: name, enabled: !!enabled }) },
      restart: function () { return postJson('/dsh-restart', {}) },
    }

    // -----------------------------------------------------------------------
    // Components
    // -----------------------------------------------------------------------
    function Toggle(props) {
      return createElement('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        disabled: props.disabled,
        onClick: props.onChange,
        className: 'dshrt-toggle' + (props.checked ? ' dshrt-toggle-on' : ''),
      }, createElement('span', { className: 'dshrt-toggle-knob' }))
    }

    function NoticeBar(props) {
      var notice = props.notice
      return createElement('div', {
        className: 'dshrt-notice dshrt-notice-' + notice.kind,
        role: 'status',
        'aria-live': 'polite',
      },
        createElement('div', { className: 'dshrt-notice-main' },
          createElement('span', { style: { fontWeight: 600 } }, notice.text),
          notice.detail ? createElement('span', { className: 'dshrt-notice-detail' }, notice.detail) : null,
        ),
        notice.restart ? createElement('button', { type: 'button', className: 'dshrt-mini', onClick: props.onRestart }, props.t('restartButton')) : null,
        createElement('button', {
          type: 'button',
          className: 'dshrt-ghost',
          onClick: props.onDismiss,
          'aria-label': props.t('dismiss'),
          style: { alignSelf: 'flex-start', marginTop: 2 },
        }, '\u2715'),
      )
    }

    function PluginRow(props) {
      var plugin = props.plugin
      return createElement('div', { className: 'dshrt-row' },
        createElement('div', { className: 'dshrt-row-main' },
          createElement('div', { className: 'dshrt-row-name' },
            createElement('span', null, plugin.name),
            plugin.repo ? createElement('a', {
              className: 'dshrt-row-repo',
              href: 'https://github.com/' + plugin.repo,
              target: '_blank',
              rel: 'noopener noreferrer',
              title: plugin.repo,
            }, plugin.repo) : null,
          ),
          createElement('div', { className: 'dshrt-row-meta' },
            createElement('span', { className: 'dshrt-badge ' + (plugin.enabled ? 'dshrt-badge-on' : 'dshrt-badge-off') },
              plugin.enabled ? props.t('enabled') : props.t('disabled')),
            props.pending ? createElement('span', { className: 'dshrt-chip' }, props.t('restartToApply')) : null,
          ),
        ),
        createElement(Toggle, {
          checked: plugin.enabled,
          disabled: props.disabled || props.busy,
          label: plugin.name,
          onChange: props.onToggle,
        }),
      )
    }

    function RestartSettingsSection(props) {
      var t = props.t
      var useState = React.useState
      var useEffect = React.useEffect

      var state = useState(null)
      var data = state[0]
      var setData = state[1]
      var loadingState = useState(true)
      var loading = loadingState[0]
      var setLoading = loadingState[1]
      var errorState = useState(null)
      var error = errorState[0]
      var setError = errorState[1]
      var busyState = useState(null)
      var busyName = busyState[0]
      var setBusyName = busyState[1]
      var restartingState = useState(false)
      var restarting = restartingState[0]
      var setRestarting = restartingState[1]
      var noticeState = useState(null)
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var pendingState = useState({})
      var pending = pendingState[0]
      var setPending = pendingState[1]

      function load() {
        setLoading(true)
        setError(null)
        return props.api.state().then(function (res) {
          setLoading(false)
          if (res && Array.isArray(res.plugins)) {
            setData({
              profile: res.profile,
              plugins: res.plugins,
              community: res.community || { installed: false, enabled: false },
            })
          } else {
            setError(t('error'))
          }
        })
      }

      useEffect(function () {
        load()
        function onVisibility() {
          if (!document.hidden) load()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return function () { document.removeEventListener('visibilitychange', onVisibility) }
      }, [])

      function onToggle(plugin) {
        var enabling = !plugin.enabled
        setBusyName(plugin.name)
        setNotice(null)
        props.api.setEnabled(plugin.name, enabling).then(function (res) {
          setBusyName(null)
          if (res && res.ok) {
            setPending(function (prev) {
              var next = Object.assign({}, prev)
              next[plugin.name] = true
              return next
            })
            setData(function (prev) {
              if (!prev) return prev
              return {
                profile: prev.profile,
                community: prev.community,
                plugins: prev.plugins.map(function (p) {
                  return p.name === plugin.name ? Object.assign({}, p, { enabled: enabling }) : p
                }),
              }
            })
            setNotice({ kind: 'ok', text: enabling ? t('pluginEnabledOk') : t('pluginDisabledOk'), restart: true })
          } else {
            setNotice({ kind: 'err', text: t('pluginToggleFailed'), detail: (res && res.error) || '' })
          }
        })
      }

      function onRestart() {
        if (restarting) return
        setRestarting(true)
        setNotice(null)
        props.api.restart().then(function (res) {
          if (res && res.ok) {
            setNotice({ kind: 'ok', text: t('restartStarted') })
          } else {
            setRestarting(false)
            setNotice({ kind: 'err', text: t('restartFailed'), detail: (res && res.error) || '' })
          }
        })
      }

      /**
       * Jump to Settings → Plugins → Community plugins inside the open
       * settings dialog, best-effort: click the "Plugins" nav cell, then the
       * "Community plugins" tab once it renders. Falls back to the GitHub
       * topic when the dialog/nav/tab cannot be found. Both labels are the
       * only two locales the host supports, so matching is deterministic.
       */
      function goCommunity() {
        var dialog = document.querySelector('[role="dialog"]') || document
        var sectionLabels = ['Plugins', '插件']
        var tabLabels = ['Community plugins', '社区插件']

        function findButton(root, labels, role) {
          var buttons = Array.prototype.slice.call(root.querySelectorAll('button'))
          for (var i = 0; i < buttons.length; i++) {
            var button = buttons[i]
            if (role !== null && (button.getAttribute('role') || '') !== role) continue
            var text = (button.textContent || '').trim()
            if (labels.indexOf(text) !== -1) return button
          }
          return null
        }

        var nav = findButton(dialog, sectionLabels, null)
        if (!nav) {
          window.open('https://github.com/topics/dsh-plugin', '_blank', 'noopener')
          return
        }
        nav.click()
        var tries = 0
        var timer = setInterval(function () {
          tries += 1
          var tab = findButton(dialog, tabLabels, 'tab')
          if (tab) {
            clearInterval(timer)
            tab.click()
          } else if (tries >= 12) {
            clearInterval(timer)
          }
        }, 100)
      }

      var restartDisabled = restarting
      var community = data && data.community ? data.community : null

      return createElement('div', { className: 'dshrt-root', role: 'region', 'aria-label': t('sectionLabel') },
        createElement('h2', { className: 'dshrt-title' }, t('sectionLabel')),
        createElement('p', { className: 'dshrt-subtitle' }, t('sectionHint')),
        notice ? createElement(NoticeBar, {
          notice: notice,
          t: t,
          onRestart: onRestart,
          onDismiss: function () { setNotice(null) },
        }) : null,
        createElement('div', { className: 'dshrt-cards' },
          // ---- Restart card ----
          createElement('section', { className: 'dshrt-card' },
            createElement('div', { className: 'dshrt-card-head' },
              createElement('h3', { className: 'dshrt-card-title' }, t('restartCardTitle')),
              createElement('p', { className: 'dshrt-card-hint' }, t('restartCardHint')),
            ),
            createElement('div', { className: 'dshrt-card-body dshrt-restart-body' },
              createElement('button', {
                type: 'button',
                className: 'dshrt-primary',
                disabled: restartDisabled,
                onClick: onRestart,
                'aria-busy': restarting ? 'true' : 'false',
              }, restarting ? t('restarting') : t('restartButton')),
              data ? createElement('span', { className: 'dshrt-meta' }, t('profile') + ': ' + data.profile) : null,
            ),
          ),
          // ---- Installed plugins card ----
          createElement('section', { className: 'dshrt-card' },
            createElement('div', { className: 'dshrt-card-head' },
              createElement('h3', { className: 'dshrt-card-title' }, t('pluginsCardTitle')),
              createElement('p', { className: 'dshrt-card-hint' }, t('pluginsCardHint')),
            ),
            createElement('div', { className: 'dshrt-card-body' },
              loading ? [
                createElement('div', { key: 'sk1', className: 'dshrt-sk', role: 'status', 'aria-label': t('loading') }),
                createElement('div', { key: 'sk2', className: 'dshrt-sk' }),
                createElement('div', { key: 'sk3', className: 'dshrt-sk' }),
              ] :
              error ? createElement('div', { className: 'dshrt-error' },
                createElement('span', null, error),
                createElement('button', { type: 'button', className: 'dshrt-secondary', onClick: load }, t('retry')),
              ) :
              !data || data.plugins.length === 0 ? createElement('p', { className: 'dshrt-empty' }, t('noPlugins')) :
              data.plugins.map(function (plugin) {
                return createElement(PluginRow, {
                  key: plugin.name,
                  plugin: plugin,
                  t: t,
                  busy: busyName === plugin.name,
                  pending: !!pending[plugin.name],
                  disabled: restartDisabled,
                  onToggle: function () { onToggle(plugin) },
                })
              }),
            ),
          ),
          // ---- More plugins card ----
          createElement('section', { className: 'dshrt-card' },
            createElement('div', { className: 'dshrt-card-head' },
              createElement('h3', { className: 'dshrt-card-title' }, t('moreCardTitle')),
              createElement('p', { className: 'dshrt-card-hint' }, t('moreCardHint')),
            ),
            createElement('div', { className: 'dshrt-card-body' },
              community && community.installed && community.enabled ?
                createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                  createElement('button', { type: 'button', className: 'dshrt-secondary', onClick: goCommunity }, t('browseMore')),
                  createElement('p', { className: 'dshrt-footnote' }, t('browseMoreHint')),
                ) :
                createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                  createElement('p', { className: 'dshrt-footnote' },
                    community && community.installed ? t('communityDisabledHint') : t('communityMissingHint')),
                  createElement('a', {
                    className: 'dshrt-link',
                    href: 'https://github.com/topics/dsh-plugin',
                    target: '_blank',
                    rel: 'noopener noreferrer',
                  }, t('openGithub')),
                ),
            ),
          ),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // Plugin entry
    // -----------------------------------------------------------------------
    function apply(ctx) {
      var locale = ctx.get('locale')
      var slots = ctx.get('slots')
      var t

      if (locale && typeof locale.register === 'function') {
        try {
          ctx.effect(function () { return locale.register(NS, STRINGS) }, 'dsh-restart: dictionaries')
          t = locale.bind(NS)
        } catch (e) {
          t = makeT(STRINGS, resolveBrowserLocale())
        }
      } else {
        t = makeT(STRINGS, resolveBrowserLocale())
      }

      slots.inject('settings.section', function () {
        return slots.register({
          name: 'settings.section',
          id: 'restart',
          order: 100,
          label: function () { return t('sectionLabel') },
          locale: NS,
          inject: function () { return { api: face } },
        }, RestartSettingsSection)
      })
    }

    exports.name = 'dsh-restart'
    exports.inject = ['slots', 'locale']
    exports.apply = apply

    return module.exports
  },
})
