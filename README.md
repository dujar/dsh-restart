# dsh-restart

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：在 **设置 → 重启** 中一键重启 `dsh web` 进程、开关已安装插件，并直接跳转社区插件页安装更多。中英双语界面（跟随宿主全局语言，zh / en，实时切换）。

## 功能

- **重启 dsh web** — 单个按钮重启宿主 web 进程。重启器为 detached 辅助进程，轮询等待端口真正释放（最长 20s）后再拉起新进程，避免旧进程退出慢导致新进程 `EADDRINUSE` 静默崩溃；新实例继承原终端的 stdio，服务恢复后页面自动重新加载。
- **启停已安装插件** — 列出当前 profile 的全部第三方插件（`dsh.profile.bundles` 与 `dependencies` 的并集，排除 `@deepseek-ai/*` 与 `cordis:*` 内置项），每个插件一个开关，直接写入 profile 清单（`dsh.profile.bundles`），重启后生效。已改未重启的行显示「重启后生效」标记，通知栏提供一键重启。本地安装的插件（`link:`/`file:` 规格）额外显示磁盘上已存在的 git 信息 —— **本地构建** 或 **本地分支**、当前分支、首个远程的名称与地址（如 `本地分支 · origin/main · https://github.com/dujar/dsh-pocket.git`）—— 仅读取 `.git`，无网络请求，支持 worktree。
- **更多插件** — 检测到 dsh-community-plugins 已安装并启用时，按钮直接跳转 **设置 → 插件 → 社区插件** 页；未安装时卡片广告 **dujar/dsh-community-plugin**，提供一键安装（执行 `dsh plugin --profile <p> add github:dujar/dsh-community-plugin`）与仓库链接。
- **切换分支与重装** — 本地 git 检出获得 Git 面板（⎇）：跨仓库（本地 / origin / upstream）切换分支（同名分支自动改设跟踪），以及二次确认的 *重装* 全新清理 — 从本地（`git reset --hard` + `git clean -fdx`）或该插件自己的任一远程（fetch 后硬重置到默认分支）。
- **卸载** — 每行插件提供二次确认的卸载，从 `dsh.profile.bundles` 与 `dependencies` 移除（内置包拒绝）；磁盘文件保留不动。
- **fail-closed 信任校验** — 所有路由沿用 dsh-trader / dsh-community-plugins 的同源/localhost 校验。

## 截图

设置 → 重启 分区（中文界面）：

![重启分区](screenshots/zh/section.png)

切换插件开关后显示待生效状态与重启快捷入口：

![待生效状态](screenshots/zh/pending.png)

「浏览更多插件」跳转社区插件页：

![社区插件跳转](screenshots/zh/community.png)

Git 面板 — 跨仓库（本地 / origin / upstream）切换分支，并可从同一来源重装（全新清理）：

![Git 面板](screenshots/zh/git.png)

## 安装

> 需要 Node.js 22.19+ 与 pnpm（`dsh plugin` 底层通过 pnpm 安装）。

```sh
# 本地开发
dsh plugin --profile web add /path/to/dsh-restart

# 发布后从远端安装
dsh plugin --profile web add github:<you>/dsh-restart
```

然后**重启 `dsh web`** 并刷新浏览器页面。安装会自动把 `dsh-restart` 加入 profile 的 `dsh.profile.bundles`；若未加入，请手动把 `"dsh-restart"` 追加到 `$DSH_HOME/profiles/web/package.json` 的该数组并重启。设置侧边栏底部即出现「重启」分区。

## 使用

1. 打开 **设置 → 重启**。
2. **立即重启** 重启 dsh web 进程；新实例就绪后页面自动重新加载。
3. 切换任意插件的开关以挂载/卸载 — profile 清单立即更新，重启后生效。「重启后生效」标记与通知栏的 *重启* 按钮会明确提示当前待生效的更改。
4. **浏览更多插件** 打开 **设置 → 插件 → 社区插件**，可搜索并从社区目录安装（由 dsh-community-plugins 提供）。
5. 本地检出插件可点 **⎇ 切换分支** 打开 Git 面板：选择仓库（本地 / 各远程）与分支 — 从不同仓库选择同名分支会改设跟踪（`git branch --set-upstream-to` / `--unset-upstream`）而非无效操作。下方的 **重装** 行即全新清理：*本地* 丢弃全部本地改动与未跟踪文件（`git reset --hard` + `git clean -fdx`），选择远程则 fetch 后硬重置到该远程默认分支。两者均需二次确认。
6. **卸载**（行尾）将该插件从 `dsh.profile.bundles` 与 `dependencies` 移除 — 重启后生效；磁盘上的检出文件保留不动。

## 路由（宿主半）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-restart/state` | profile、已安装插件列表（含 enabled 与本地 git 元信息）、dsh-community-plugins 可用性 |
| POST | `/dsh-restart/plugin` | `{ name, enabled }` — 增删 `dsh.profile.bundles` 成员 |
| POST | `/dsh-restart/community` | 一键安装 `github:dujar/dsh-community-plugin`（`DSH_BIN` 可覆盖可执行文件） |
| GET | `/dsh-restart/git-refs` | `?name=<插件>` — 本地检出的分支与远程引用（无网络） |
| POST | `/dsh-restart/git-checkout` | `{ name, branch, remote }` — 切换分支（按仓库调整跟踪） |
| POST | `/dsh-restart/uninstall` | `{ name }` — 从 bundles 与 dependencies 移除（内置包拒绝） |
| POST | `/dsh-restart/reinstall` | `{ name, remote }` — 全新清理本地检出（本地或该插件自己的 git 远程） |
| POST | `/dsh-restart` | 调度自重启；先返回 `{ ok, restarting }`，约 400 ms 后进程退出 |

所有路由使用与 dsh-trader / dsh-community-plugins 相同的 fail-closed 同源/localhost 信任校验：跨源或异常的 `Origin`/`Referer` 一律拒绝，CORS-simple 类型拒绝，仅当 Host 为 localhost 时才视为可信。

## 配置

环境变量（均可选）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_RESTART_CMD` | 原启动命令行 | 自定义重启命令（如 `systemctl restart dsh-web`），用于 systemd 等托管场景。 |
| `DSH_RESTART_PROFILE` | 自动检测 | 指定 profile；回退 `DSH_PROFILE` → 自动检测挂载本插件的 profile → `web`。 |

## 开发

零构建插件（同 dsh-community-plugins / dsh-better-archive 模式）：

```sh
npm test          # host 路由 + client 契约/字典平衡 + 真实 React 服务端渲染
node --check lib/index.js && node --check lib/client.js
```

- 客户端：`lib/client.js`（CJS factory + ModuleLoader，React 来自宿主）。
- 宿主：`lib/index.js`（`ctx.webServer.register` 挂载路由）。
- i18n：`ctx.locale.register('restart', { zh, en })` — 宿主强制 zh/en 键对等，新增文案必须同时加两个字典。

## 发布

发布到 GitHub 前，请为仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 主题标签，以便在社区目录中被发现（DeepSeek Harness 官方 README 的要求）。

## 许可

[MIT](./LICENSE)
