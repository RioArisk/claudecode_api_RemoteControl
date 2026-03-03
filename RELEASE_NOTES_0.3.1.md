# Claude Remote App v0.3.1 / Bridge v0.3.0

本次版本修复了客户端假连接（幽灵连接）问题与弹窗被键盘遮挡问题，并强化了保活探测的准确性与 WebSocket 消息的来源校验，使整体连接与交互体验更稳定、更可靠。

## 修复

- **假连接 / 幽灵连接消除**：`foreground_probe_ack` 现在严格校验 probeId，不匹配的陈旧 ack 将被忽略，不再错误地重置 `resumeRequestedFor` 或触发 `syncSessionState`
- **旧 Socket 消息隔离**：所有 WebSocket 回调（`onopen` / `onmessage` / `onclose` / `onerror`）新增 `isCurrentSocket()` guard，来自非当前连接的延迟消息将被静默丢弃
- **弹窗键盘遮挡**：Hub 添加服务器弹窗、问题选择弹窗、计划审批弹窗在 Android 虚拟键盘弹出时不再被遮挡，通过 `visualViewport` 动态计算键盘高度并上移弹窗内容

## 优化

- **离线日志缓冲**：WebSocket 断开期间的 debug 日志自动缓存（最多 120 条），重连后批量回传，避免丢失关键诊断信息
- **生命周期感知重连**：监听 `visibilitychange` / `focus` / `online` / `pageshow` 等事件，App 回到前台时自动探测连接健康并按需恢复
- **增强诊断日志**：`ws_open` / `ws_close` / `ws_error` / `syncSessionState` 等关键路径新增 `wsState`、`hidden`、`online`、`close code/reason` 等字段，便于远程排查连接问题
- **Server 端探活支持**：Bridge 新增 `foreground_probe` 消息处理，回复带 `sessionId` / `lastSeq` / `cwd` 的 ack，配合客户端探活流程

> 建议 Server（Bridge）同步更新至 v0.3.0 以获得最佳体验。
