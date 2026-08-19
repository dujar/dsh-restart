# dsh-restart

DeepSeek Harness 插件：在 **设置 → 重启** 中一键重启 dsh web、开关已安装插件，并跳转社区插件页安装更多。中英双语界面（跟随宿主全局语言，zh / en）。

## 功能

- **重启 dsh web** — 单个按钮重启宿主 web 进程。重启器为 detached 辅助进程，轮询等待端口真正释放（最长 20s）后再拉起新进程，避免旧进程退出慢导致新进程 EADDRINUSE 静默崩溃；新进程继承原终端输出。重启命令可用环境变量覆盖：
  - `DSH_RESTART_CMD` — 自定义重启命令（如 `systemctl restart dsh-web`）；缺省时按原启动命令行重新拉起。
  - `DSH_RESTART_PROFILE` / `DSH_PROFILE` — 指定配置文件；缺省自动检测挂载本插件的 profile（回退 `web`）。
- **启停已安装插件** — 列出当前 profile 的全部第三方插件（`dsh.profile.bundles` 与 `dependencies` 的并集，排除 `@deepseek-ai/*` 与 `cordis:*` 内置项），每个插件一个开关，写入 profile 的 `package.json`，重启后生效。已改未重启的行显示「重启后生效」标记。
- **更多插件** — 检测到 dsh-community-plugins 已安装并启用时，按钮直接跳转 **设置 → 插件 → 社区插件** 页；未安装/未启用时给出提示与 GitHub dsh-plugin 主题链接。

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-restart
# 然后把 "dsh-restart" 加入 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles
```

重启 dsh web 后，设置侧边栏末尾出现「重启」分区。

## 路由（宿主半）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-restart/state` | profile、已安装插件列表（含 enabled）、dsh-community-plugins 可用性 |
| POST | `/dsh-restart/plugin` | `{ name, enabled }` — 增删 `dsh.profile.bundles` 成员 |
| POST | `/dsh-restart` | 调度自重启，响应返回后 400ms 退出进程 |

所有路由沿用 dsh-trader / dsh-community-plugins 的 fail-closed 同源/localhost 信任校验。

## 开发

零构建插件（同 dsh-community-plugins / dsh-better-archive 模式）：

```sh
npm test          # host 路由 + client 契约/字典平衡 + 真实 React 服务端渲染
node --check lib/index.js && node --check lib/client.js
```

- 客户端：`lib/client.js`（CJS factory + ModuleLoader，React 来自宿主）。
- 宿主：`lib/index.js`（`ctx.webServer.register` 挂载路由）。
- i18n：`ctx.locale.register('restart', { zh, en })`，宿主强制 zh/en 键对等——新增文案必须同时加两个字典。

## 许可

MIT
