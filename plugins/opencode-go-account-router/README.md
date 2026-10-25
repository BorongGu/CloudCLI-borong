# OpenCode Go Account Router

面向 OpenCode 1.18 的账号路由插件。将各自授权的 Go Key 加入账号池，按每个账号的独立额度选择账号，适用于原生 OpenCode 和通过 `opencode run` 工作的 CloudCLI。

## 路由行为

- 查询 Go usage 接口，分别保存 rolling（5 小时）、weekly、monthly 的使用比例和恢复时间，默认缓存 30 秒。
- 新会话按账号优先级选择；已有会话保持所选账号，遇到额度耗尽后换到下一个可用账号。
- 收到 429、401，或者明确表示额度耗尽的 402/403 时，更新冷却状态并切换账号。每次逻辑请求对每个账号最多尝试一次。
- 额度恢复后，账号重新参与新会话的选择；已有会话沿用当前账号。
- 全部账号耗尽时返回 429，以及最早可重试的时间。
- 会话映射、额度、冷却和切换记录通过文件锁与原子写入持久化，支持多个 OpenCode CLI 进程共用。
- 兼容 Go 模型使用的 OpenAI、Anthropic、Google 接口格式，随账号替换对应的鉴权信息。
- 成功响应直接交回 SDK，保留流式输出和原生会话上下文。普通服务错误、网络中断交给原有调用链处理。

Go usage 接口暂时失联时，插件使用上次的额度记录，并根据推理接口的明确拒绝更新冷却时间。429 的 `Retry-After` 优先于默认 60 秒冷却。401 使用 1 小时冷却。usage 记录覆盖账号的三个窗口；推理接口单独返回的额度拒绝按模型记录。

## 构建与安装

Node.js 22+，已验证 OpenCode 1.18.32。

```bash
npm ci
npm test
npm pack
npm install --prefix "$HOME/.local/share/opencode-go-router" ./opencode-go-account-router-0.1.0.tgz
```

在 `opencode.json` 的 `plugin` 数组中加入安装后的入口，例如：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///home/YOUR_USER/.local/share/opencode-go-router/node_modules/opencode-go-account-router/dist/src/index.js"
  ]
}
```

入口也支持配置参数：

```json
{
  "plugin": [["file:///ABSOLUTE/PATH/dist/src/index.js", {
    "stateDir": "/ABSOLUTE/PRIVATE/STATE/DIRECTORY"
  }]]
}
```

`--pure` 会跳过外部插件。运行账号路由时使用正常的插件加载模式。Go provider 在原生 `auth.json` 中需要有一条授权记录，OpenCode 会据此调用插件的 auth loader；`opencode auth login` 中的 **Add Go router account** 也可以建立该记录。

## 添加与管理账号

下面命令中的 `opencode-go-router` 指安装目录 `node_modules/.bin/opencode-go-router`，可将该目录加入 PATH 或创建启动脚本。

导入当前已登录的 Go Key：

```bash
opencode-go-router import-current "我的账号"
```

添加爱人的 Key，使用 Bash 的隐藏输入：

```bash
read -r -s -p 'Go Key: ' GO_ROUTER_KEY
printf '%s' "$GO_ROUTER_KEY" | opencode-go-router add "爱人" --key-stdin
unset GO_ROUTER_KEY
```

```bash
opencode-go-router quota                 # 刷新额度并显示三个窗口、恢复时间
opencode-go-router status                # 查看缓存状态及最近切换记录
opencode-go-router prefer "爱人"          # 新会话优先使用该账号
opencode-go-router disable "爱人"         # 暂停该账号参与路由
opencode-go-router enable "爱人"          # 恢复参与路由
opencode-go-router remove "爱人"          # 从本机账号池移除
```

账号 ID 和标签均可用于管理命令。采用唯一标签便于识别。调整优先级后，已有会话保持当前账号；暂停账号后，该账号上的会话在下一次请求时重新选取。

状态目录默认是 `~/.config/opencode-go-router`，可用 `OPENCODE_GO_ROUTER_HOME` 指定。自定义插件 `stateDir` 时，CLI 使用相同目录的环境变量。目录权限为 0700，包含 Key 的 `state.json` 为 0600。`status`/`quota` 显示 Key 的 SHA-256 指纹、额度和账号 ID。切换记录保留最近 200 条，会话映射保留最近 2000 条。

## CloudCLI 接入

CloudCLI 每次聊天请求启动一个 OpenCode CLI 进程。让它调用的 `opencode` 启动脚本载入本插件，并让所有进程使用相同状态目录，即可共享账号池与冷却信息。`chat.headers` 钩子传递原生 session ID，后续请求据此保持账号选择。

可为 CloudCLI 设置独立 `XDG_CONFIG_HOME`，在其 `opencode/opencode.json` 中加载本插件；原生认证数据仍由 `XDG_DATA_HOME` 下的 OpenCode 授权存储提供。前端继续使用原有的 Go 模型和会话列表，账号选择在请求层完成。

本机部署记录见 `~/.config/cloudcli/DEPLOYMENT.txt`。

## 验证范围

自动化测试覆盖三个额度窗口、429/402/403/401、恢复时间、跨进程存储、会话保持、手动优先级、请求内容保留、流式输出和插件入口。双账号额度耗尽通过测试传输层模拟，可在保留实际订阅额度的情况下验证切换过程。

接口参考：[OpenCode 插件文档](https://opencode.ai/docs/plugins/)，[OpenCode 1.18.32 插件加载器](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/plugin/index.ts)。
