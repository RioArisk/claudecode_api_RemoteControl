# Claude Remote

> 在手机上远程操控 Claude Code —— 随时随地写代码、审批权限、切换模型。

## 这是什么？

一个轻量级的远程控制桥接器，让你可以通过 Android App 连接到电脑上运行的 Claude Code，实现：

- 💬 远程对话 —— 发消息、看回复、完整的 Markdown 渲染
- 🔧 工具调用可视化 —— 实时查看 Claude 正在读哪个文件、执行什么命令
- 🔐 权限审批 —— 手机上一键 Allow / Deny
- 🔄 模式切换 —— Default / Plan / Accept Edits / Bypass
- 📱 斜杠命令 —— /model /compact /clear /cost /help

## 快速开始

### 1. 安装

```bash
npm install -g claude-remote
```

### 2. 启动

在任意项目目录下运行：

```bash
claude-remote
```

会在当前目录启动 Claude Code 并开启远程控制服务（默认端口 3100）。

#### 参数透传

`claude-remote` 支持将参数直接传递给 Claude Code CLI：

```bash
# 恢复指定会话
claude-remote --resume <session-id>

# 继续最近的对话
claude-remote -c

# 指定模型
claude-remote --model opus

# 组合使用
claude-remote --model sonnet -c

# 指定工作目录 + 恢复会话
claude-remote /path/to/project --resume abc123
```

> 不兼容参数（`--print`、`--output-format`、`--version` 等非交互模式参数）会被自动过滤并在启动 banner 中提示。

指定端口：

```bash
PORT=8080 claude-remote
```

### 3. App 连接

安装 Android App 后，在设置页输入服务器地址连接。根据你的网络环境，有以下三种方式：

#### 方式一：局域网直连

手机和电脑在同一 Wi-Fi 下，直接输入电脑内网 IP：

```
ws://<电脑IP>:3100
```

> 适合在家或办公室使用，最简单、延迟最低。

#### 方式二：Tailscale 组网

通过 [Tailscale](https://tailscale.com) 虚拟局域网，手机和电脑不在同一网络也能连接。

1. 电脑和手机都安装 Tailscale 并登录同一账号
2. 在 Tailscale 管理面板查看电脑的 Tailscale IP（通常是 `100.x.x.x`）
3. App 中输入：

```
ws://<Tailscale IP>:3100
```

> 适合跨网络使用，无需公网暴露，安全可靠。

#### 方式三：Cloudflare Tunnel 公网访问

通过 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 将本地服务暴露到公网。

1. 安装 `cloudflared` 并登录
2. 启动隧道：

```bash
cloudflared tunnel --url http://localhost:3100
```

3. 获得一个 `https://xxx.trycloudflare.com` 的地址
4. App 中输入（注意用 `wss://`）：

```
wss://xxx.trycloudflare.com
```

> 适合在外网或移动网络下远程控制，支持 HTTPS/WSS 加密。

### 4. 编译 Android App

```bash
cd app
npm install
npx tauri android init
npx tauri android dev
```

## 架构

```
┌─────────────┐     WebSocket     ┌──────────────┐     PTY      ┌────────────┐
│  Android App│ ◄──────────────► │  server.js   │ ◄──────────► │ Claude Code│
│             │   ws://ip:3100   │  (Bridge)    │   node-pty   │   (CLI)    │
└─────────────┘                   └──────────────┘              └────────────┘
                                        │
                                        │ 读取 JSONL transcript
                                        ▼
                                  ~/.claude/projects/
```

**server.js** 是核心桥接层：
- 通过 `node-pty` 启动并管理 Claude Code CLI 进程
- 监听 `~/.claude/projects/` 下的 JSONL transcript 文件，实时解析事件
- 通过 WebSocket 将事件广播给所有连接的客户端
- 转发客户端输入到 Claude PTY

## 功能特性

| 功能 | 说明 |
|------|------|
| 实时对话 | 完整 Markdown + 代码高亮渲染 |
| 工具调用追踪 | 折叠式 step group，shimmer 加载动效 |
| 权限队列 | 批量审批，计数器显示剩余数量 |
| 模式切换 | 四种模式一键切换，彩色状态标识 |
| 对话压缩 | /compact 带 spinner 遮罩，压缩完自动恢复 |
| 斜杠命令菜单 | 输入 `/` 弹出命令面板 |
| 模型切换 | 底部面板选择，toast 即时反馈 |
| 断线重连 | 自动重连 + 事件回放，不丢消息 |
| 图片上传 | 手机拍照/选图发送到 Claude Code |
| 代码 Diff | GitHub 风格行内高亮 |
| 安卓适配 | 安全区、虚拟键盘、大触摸目标 |

## 依赖

- **Node.js** >= 18
- **node-pty** —— PTY 终端模拟
- **ws** —— WebSocket 服务
- **Tauri 2.0** —— Android App（需要 Rust 工具链）

## TODO

> 本项目看到 Claude Code 官方远程控制，可惜不支持 API 调用的模式，于是空闲时间摸鱼用 vibing code 写的小东西，目前处于快速迭代阶段。

- [x] 提问与计划远程弹窗（AskUserQuestion / ExitPlanMode 远程交互）
- [x] 自动审批命令模式
- [x] Claude Code ToDo App 渲染
- [x] 美化部分样式
- [x] 代码 diff 查看
- [x] 缓存机制 —— 避免每次 App 重连全量回放
- [x] App 支持图片上传
- [x] /命令指令及样式美化
- [x] npm 包化 —— `npm install -g claude-remote` 全局安装，`claude-remote` 一键启动
- [x] AI 截图显示 —— 工具返回的图片（如 Playwright 截图）全宽渲染，点击全屏查看
- [x] CLI 参数透传 —— `claude-remote --resume xxx` 等参数直接传给 Claude Code，自动过滤不兼容参数
- [x] 多客户端同步 —— 多台设备同时连接，Working 状态和消息实时同步
- [x] 会话生命周期管理 —— 通过 SessionStart Hook 自动绑定会话 ID，支持 /clear 切换检测
- [ ] Tool Use 状态渲染（进行中 / 成功 / 失败）
