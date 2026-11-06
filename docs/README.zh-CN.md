<div align="center">
  <img src="../public/orbit-icon.svg" alt="Orbit" width="72" height="72">
  <h1>Orbit</h1>
  <p>面向桌面和手机的 coding agent 工作台。</p>
  <p><strong>基于 <a href="https://github.com/siteboon/claudecodeui">CloudCLI（又名 Claude Code UI）</a> 的独立维护 fork。</strong></p>
</div>

<p align="center">
  <a href="https://github.com/BorongGu/Orbit">项目仓库</a> ·
  <a href="https://github.com/BorongGu/Orbit/issues">问题反馈</a> ·
  <a href="../README.md">English</a> ·
  <a href="architecture/README.md">架构文档</a> ·
  <a href="../LICENSE">AGPL-3.0-or-later</a>
</p>

Orbit 沿用 CloudCLI 的 agent 集成、聊天、终端、文件管理和 Git 工具，并持续开发自己的主题、阅读体验、会话工作流和多 agent 协作功能。原项目及贡献者的署名保留在下方。

## 支持的 agent

- Claude Code
- OpenAI Codex
- OpenCode，包括 OpenCode Go 账号路由
- Cursor CLI

在运行 Orbit 的电脑上安装并登录需要使用的 CLI。模型列表从各 provider 的模型目录加载。

## 主要功能

- **桌面与手机会话管理**：项目与对话视图、会话置顶、运行状态、历史搜索和阅读位置暂存。
- **聊天与阅读**：流式 Markdown、表格、行内和行外 LaTeX、公式选中复制、图片附件和全屏阅读。
- **五种外观**：Claude、GitHub、Linear、纸页阅读和 Raycast，支持明暗模式和聊天字号设置。
- **上下文与额度**：显示 context 窗口用量、自动压缩状态和订阅剩余额度。
- **旁支对话**：`/btw <问题>` 为 Codex 或 OpenCode 开启继承上下文的临时对话。每个主会话分别保留窗口、草稿和旁支消息，支持切换会话及刷新后恢复。
- **Agent 协作**：群组讨论、同伴输入、任务分发，以及会话上下文传递和交接。
- **工作区工具**：终端、文件编辑、Git 操作、插件、浏览器任务和可选的 TaskMaster 集成。

## 从源码运行 Orbit

准备 Node.js 22 或更高版本、npm、Git，以及需要使用的 agent CLI。

```bash
git clone https://github.com/BorongGu/Orbit.git
cd Orbit
npm ci
npm run build
```

以 localhost 模式启动：

```bash
HOST=127.0.0.1 SERVER_PORT=3001 npm run server
```

打开 **http://localhost:3001**，完成网页账号设置。

通过 Tailscale 供其他设备访问时，将服务绑定到本机的 Tailnet 地址：

```bash
orbit_tailnet_ip="$(tailscale ip -4)" &&
  test -n "$orbit_tailnet_ip" &&
  HOST="$orbit_tailnet_ip" SERVER_PORT=3001 npm run server
```

在同一 Tailnet 中的设备打开服务输出的地址。远程使用期间，运行 Orbit 的电脑和服务进程保持运行。

现有包名 `@cloudcli-ai/cloudcli` 和命令名 `cloudcli` 沿用 CloudCLI 的命名以兼容已有工具。使用 Orbit 的改动请构建本仓库；公开发布的 CloudCLI npm 包和 CloudCLI Cloud 由上游项目维护。

### 配置

配置选项见 [`.env.example`](../.env.example)。

| 环境变量 | 用途 |
| --- | --- |
| `HOST` | 服务监听地址，例如 `127.0.0.1` 或本机的 Tailnet 地址 |
| `SERVER_PORT` | HTTP 和 WebSocket 端口，默认 `3001` |
| `DATABASE_PATH` | 可选的本地应用数据库路径 |
| `CLAUDE_CLI_PATH` | 可选的 Claude Code 可执行文件路径 |

采用仓库内[本地部署脚本](../scripts/local-deployment/)的 Linux 安装，可以在启动已配置的 systemd 服务时选择访问模式：

```bash
python3 scripts/local-deployment/cloudcli-start.py
# 也可以直接指定：
python3 scripts/local-deployment/cloudcli-start.py localhost
python3 scripts/local-deployment/cloudcli-start.py tailnet
```

该辅助脚本使用已有的 `codex-web.service` 和 `~/.config/cloudcli/server.env` 配置。

## 开发

后续开发统一在 **`main`** 上进行，修改前先拉取最新提交：

```bash
git switch main
git pull --ff-only origin main
npm ci
HOST=127.0.0.1 npm run dev
```

开发前端使用 `5173` 端口，并将 API 和 WebSocket 请求代理到 `3001` 端口的后端。

常用检查：

```bash
npm run test:client
npm test
npm run typecheck
npm run lint
npm run build
```

更新源码安装时，拉取 `main`、安装当前依赖并重新构建，再按选定的访问模式启动新版本服务。

## 文档

- [架构总览](architecture/README.md)
- [消息存储与懒加载](architecture/04-message-store-and-lazy-loading.md)
- [滚动与阅读位置](architecture/05-scrolling.md)
- [Agent 群组](architecture/07-groups.md)
- [上下文传递](architecture/08-context-transfer.md)
- [Provider 集成](../server/modules/providers/README.md)
- [WebSocket 协议](../server/modules/websocket/README.md)
- [OpenCode Go 账号路由](../plugins/opencode-go-account-router/README.md)
- [贡献指南](../CONTRIBUTING.md)

上游 CloudCLI 的[文档](https://cloudcli.ai/docs)与[插件模板](https://github.com/cloudcli-ai/cloudcli-plugin-starter)提供更多平台背景和扩展说明。

## Fork 来源与致谢

**Orbit 是 [CloudCLI / Claude Code UI](https://github.com/siteboon/claudecodeui) 的 fork，原项目由 Siteboon 和 CloudCLI 贡献者开发。** 本仓库在他们的工作基础上持续迭代。

- 上游项目：[`siteboon/claudecodeui`](https://github.com/siteboon/claudecodeui)
- 当前 fork：[`BorongGu/Orbit`](https://github.com/BorongGu/Orbit)
- 上游官网：[cloudcli.ai](https://cloudcli.ai)

感谢 React、Vite、Tailwind CSS、CodeMirror、xterm.js、KaTeX 及各 agent SDK。字体许可证与来源说明保存在 [`public/fonts/`](../public/fonts/)。

## 许可证

沿用 [GNU Affero General Public License v3.0 or later](../LICENSE)（**AGPL-3.0-or-later**），包含现有的第 7 节附加条款。原始许可证和版权声明予以保留。
