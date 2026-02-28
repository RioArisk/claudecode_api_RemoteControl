# Claude Remote

> 在手机上远程操控 Claude Code —— 随时随地写代码、审批权限、切换模型。

## 这是什么？

一个轻量级的远程控制桥接器，让你可以通过手机浏览器或 Android App 连接到电脑上运行的 Claude Code，实现：

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

指定端口：

```bash
PORT=8080 claude-remote
```

### 3. 手机访问

确保手机和电脑在同一局域网，浏览器打开：

```
http://<电脑IP>:3100
```

### 4. Android App（可选）

```bash
cd app
npm install
npx tauri android init
npx tauri android dev
```

App 启动后输入 server 地址连接即可。

## 架构

```
┌─────────────┐     WebSocket     ┌──────────────┐     PTY      ┌────────────┐
│  手机浏览器  │ ◄──────────────► │  server.js   │ ◄──────────► │ Claude Code│
│  / App      │    ws://ip:3100   │  (Bridge)    │   node-pty   │   (CLI)    │
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
| 外部链接 | 点击链接跳转系统浏览器，不影响 WebView |
| 安卓适配 | 安全区、虚拟键盘、大触摸目标 |

## 依赖

- **Node.js** >= 18
- **node-pty** —— PTY 终端模拟
- **ws** —— WebSocket 服务
- **Tauri 2.0** —— Android App（可选，需要 Rust 工具链）

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
- [ ] Tool Use 状态渲染（进行中 / 成功 / 失败）
