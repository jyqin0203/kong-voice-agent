# Protocol

这份文档定义当前控制面 WebSocket 协议、WebRTC signaling 消息的形态、方向、示例和约束。当前版本以 mock 闭环为优先，但协议本身要保持对真实 ASR / LLM / TTS 的可替换性。

## 基本约定

- 传输层：WebSocket
- 实时媒体层：WebSocket PCM 或 WebRTC 音轨
- 登录接口：`POST /api/auth/login`
- WebSocket 连接地址：`/ws/agent?token=<login-token>`
- 需要恢复既有后端会话时，控制面重连可追加 `sessionId`：`/ws/agent?token=<login-token>&sessionId=<existing-session-id>`
- 音频：二进制 PCM frame
- 控制、文本输入与状态：JSON 文本消息
- 下行消息都会携带 `sessionId` 和 `turnId`；尚未创建用户 turn 时 `turnId` 为 `null`，创建后为服务端雪花 ID 字符串
- 上行控制消息当前最小字段是字符串 `type`，服务端默认以 WebSocket 连接定位 session；WebRTC 模式下也在当前控制面连接对应的同一个 `sessionId` 上完成 signaling 和媒体挂载
- 服务端内置支持 `ping`、`interrupt`、`audio_end` 和 `text`，业务方可以通过 Spring Bean 新增自定义 type
- 过期消息要按 `turnId` 做字符串相等性判断后丢弃，不要依赖数值自增或大小比较
- 本版本不支持 preemptive，`turn committed` 之前不启动 LLM
- WebSocket 握手阶段必须携带登录得到的 `token` query 参数；缺失或无效时服务端返回 401，不创建 session

## 登录协议

当前版本提供应用侧固定账号登录，用于本地 mock 闭环和前端联调。默认账号来自 `kong-voice-agent.auth.fixed-user`：

| 配置项 | 默认值 | 环境变量 |
| --- | --- | --- |
| `account-id` | `123456` | `KONG_VOICE_AGENT_AUTH_FIXED_USER_ACCOUNT_ID` |
| `username` | `demo` | `KONG_VOICE_AGENT_AUTH_FIXED_USER_USERNAME` |
| `password` | `demo123456` | `KONG_VOICE_AGENT_AUTH_FIXED_USER_PASSWORD` |

公开部署时必须覆盖默认密码，避免使用示例账号暴露服务。

### `POST /api/auth/login`

请求体：

```json
{
  "username": "demo",
  "password": "demo123456"
}
```

成功响应：

```json
{
  "token": "00000000-0000-0000-0000-000000000000",
  "tokenType": "Bearer",
  "user": {
    "accountId": "123456",
    "username": "demo"
  }
}
```

认证失败返回 HTTP 401：

```json
{
  "code": "unauthorized",
  "message": "账号或密码错误"
}
```

`token` 是服务端生成的 UUID 字符串，只保存在当前 JVM 进程内存中。服务重启后旧 token 全部失效；当前版本不提供持久化、跨实例共享、主动撤销、过期刷新或 Bearer Header WebSocket 鉴权。

## WebRTC signaling 协议

首版 WebRTC 仍保持“音频面走 RTC、控制面走 WebSocket JSON”的边界，但 signaling 本身也已经并入控制面 WebSocket，不再额外暴露 `/api/rtc/**` HTTP 接口。

## 上行协议

服务端对 JSON 文本消息采用策略注册表分发：先解析统一外壳，再按 `type`
查找对应的 `WsTextMessageHandler`。内置 type 保持稳定，业务自定义策略只能新增
type，不能覆盖内置 type；重复注册同一个 type 会在启动阶段失败，避免协议行为不确定。

所有 WebSocket 上行消息都必须在登录后发送。客户端应先调用 `POST /api/auth/login`，再用返回的 `token` 连接：

```text
ws://localhost:9877/ws/agent?token=<login-token>
```

WebRTC 模式下，控制面仍然只需要连接当前会话自己的：

```text
ws://localhost:9877/ws/agent?token=<login-token>
```

如果控制面因刷新、弱网或浏览器重连而断开，前端可在重新握手时带回历史 `sessionId`，把新的 WebSocket 重新绑定到原语音会话：

```text
ws://localhost:9877/ws/agent?token=<login-token>&sessionId=<existing-session-id>
```

### 1. `audio_chunk`

客户端发送二进制 PCM 数据。

- 默认格式：16kHz / mono / 16-bit PCM little-endian
- 默认建议每包 20ms
- 实际音频格式由服务端 `kong-voice-agent.audio` 配置决定，客户端必须发送与服务端配置一致的 PCM；当前协议不包含格式协商字段

示例：

```text
[binary pcm bytes]
```

### 2. `interrupt`

用户主动中断当前播报。

```json
{
  "type": "interrupt",
  "payload": {
    "reason": "user_speaking_again"
  }
}
```

### 3. `audio_end`

通知当前音频流结束。

```json
{
  "type": "audio_end",
  "payload": {}
}
```

### 4. `ping`

```json
{
  "type": "ping",
  "payload": {
    "ts": 1713580800000
  }
}
```

服务端会返回 `pong`，用于前端确认连接仍然可用。

### 5. `text`

客户端直接提交用户文本。服务端会为该文本创建新的 committed turn，跳过 VAD/ASR，直接进入 LLM/TTS。若 Agent 正在播报，文本输入会先打断旧 turn。

```json
{
  "type": "text",
  "payload": {
    "text": "你好，介绍一下你自己"
  }
}
```

### 6. 业务自定义 type

业务模块可以声明 `WsTextMessageHandler` Bean 扩展新的上行 JSON 文本消息类型。
自定义消息仍使用统一外壳，`payload` 在后端模型中以 `JsonNode` 保留，由业务策略自行解析和校验。
未知 type 会返回 `error`，错误码为 `bad_message`。

```json
{
  "type": "custom_event",
  "payload": {
    "value": "业务自定义内容"
  }
}
```

扩展示意：

```java
@Component
public class CustomEventWsTextMessageHandler implements WsTextMessageHandler {
    @Override
    public String type() {
        return "custom_event";
    }

    @Override
    public void handle(WsTextMessageContext context) {
        // 在这里解析 context.message().payload() 并执行业务逻辑。
    }
}
```

## 下行协议

### 1. `state_changed`

```json
{
  "type": "state_changed",
  "sessionId": "sess_001",
  "turnId": "739251562187575296",
  "timestamp": "2026-04-20T02:30:00Z",
  "payload": {
    "state": "USER_SPEAKING",
    "reason": "speech"
  }
}
```

`payload.reason` 除了 `speech`、`speech_started`、`silence_candidate`、`speech_resumed` 等状态机原因外，还可能出现 EOU 相关值：

- `eou_detected`：语义 EOU 判断当前用户话语已经结束。
- `eou_waiting`：语义 EOU 判断用户可能还会继续说，服务端继续等待。
- `eou_max_silence_fallback`：EOU 持续未确认结束，但静音超过最大等待窗口，服务端兜底提交。
- `eou_unavailable_fallback`：EOU 模型不可用，服务端按静音策略兜底提交。

### 2. `asr_partial`

```json
{
  "type": "asr_partial",
  "sessionId": "sess_001",
  "turnId": "739251562187575296",
  "timestamp": "2026-04-20T02:30:00Z",
  "payload": {
    "text": "mock partial 320ms"
  }
}
```

### 3. `asr_final`

音频输入时表示 ASR 最终结果；文本输入时表示已提交的用户文本，`payload.source` 为 `text`。

```json
{
  "type": "asr_final",
  "sessionId": "sess_001",
  "turnId": "739251562187575296",
  "timestamp": "2026-04-20T02:30:00Z",
  "payload": {
    "text": "你好，介绍一下你自己",
    "source": "audio"
  }
}
```

### 4. `agent_thinking`

```json
{
  "type": "agent_thinking",
  "sessionId": "sess_001",
  "turnId": "739251562187575296",
  "timestamp": "2026-04-20T02:30:00Z",
  "payload": {
    "transcript": "你好，介绍一下你自己"
  }
}
```

### 5. `agent_text_chunk`

```json
{
  "type": "agent_text_chunk",
  "sessionId": "sess_001",
  "turnId": "739251562187575296",
  "timestamp": "2026-04-20T02:30:00Z",
  "payload": {
    "seq": 0,
    "text": "我已收到你的语音内容：",
    "isLast": false
  }
}
```

### 6. `tts_audio_chunk`

```json
{
  "type": "tts_audio_chunk",
  "sessionId": "sess_001",
  "turnId": "739251562187575296",
  "timestamp": "2026-04-20T02:30:00Z",
  "payload": {
    "seq": 0,
    "isLast": false,
    "text": "我已收到你的语音内容：",
    "audioBase64": "TU9DS19QQ006..."
  }
}
```

`audioBase64` 当前只承载 TTS 服务返回的原始字节，不额外携带格式元数据。应用默认调用 Qwen TTS Realtime，并透传 `response.audio.delta` Base64 分片解码后的音频字节，React UI 会优先尝试浏览器解码播放；如果业务把 TTS 返回格式改成裸 PCM，前端可再按自身约定 fallback。跨 turn 播放仍必须按 `turnId` 相等性过滤。

### 7. `turn_metrics`

服务端会在当前 turn 的关键阶段下发耗时快照，便于联调时直接观察 ASR / LLM / TTS 的响应时间、总耗时，以及“用户说完话”到首字、首包音频的时延。`payload.stage` 常见值为：

- `asr_final`：当前 turn 已经拿到最终用户文本。
- `llm_first_chunk` / `llm_completed`：LLM 已输出首个非空文本片段 / 当前轮 LLM 已完成。
- `tts_first_chunk` / `tts_completed`：TTS 已输出首个音频块 / 当前轮 TTS 已完成。

```json
{
  "type": "turn_metrics",
  "sessionId": "sess_001",
  "turnId": "739251562187575296",
  "timestamp": "2026-05-03T09:30:00Z",
  "payload": {
    "stage": "tts_completed",
    "source": "audio",
    "asrResponseLatencyMs": 118,
    "asrDurationMs": 642,
    "llmResponseLatencyMs": 86,
    "llmDurationMs": 531,
    "ttsResponseLatencyMs": 74,
    "ttsDurationMs": 408,
    "speechEndToLlmFirstTokenMs": 93,
    "speechEndToTtsFirstChunkMs": 167
  }
}
```

音频 turn 中：

- `asrResponseLatencyMs`：从首个音频块进入流水线，到收到首个 ASR partial 或 final。
- `asrDurationMs`：从首个音频块进入流水线，到输出 `asr_final`。

所有 turn 中：

- `llmResponseLatencyMs`：从启动 LLM，到收到首个非空 `agent_text_chunk`。
- `llmDurationMs`：从启动 LLM，到收到最后一个完成片段。
- `ttsResponseLatencyMs`：从首次提交 TTS 合成，到收到首个 `tts_audio_chunk`。
- `ttsDurationMs`：从首次提交 TTS 合成，到收到最后一个 `tts_audio_chunk`。
- `speechEndToLlmFirstTokenMs`：从本轮 `turn committed` / `asr_final` 边界，到 LLM 输出首字。
- `speechEndToTtsFirstChunkMs`：从本轮 `turn committed` / `asr_final` 边界，到 TTS 输出首包音频。

文本输入 turn 不经过真实 ASR，相关 `asr*` 字段会缺省。

### 8. `playback_stop`

```json
{
  "type": "playback_stop",
  "sessionId": "sess_001",
  "turnId": "739251562187575296",
  "timestamp": "2026-04-20T02:30:00Z",
  "payload": {
    "reason": "interrupted"
  }
}
```

### 9. `turn_interrupted`

```json
{
  "type": "turn_interrupted",
  "sessionId": "sess_001",
  "turnId": "739251562187575296",
  "timestamp": "2026-04-20T02:30:00Z",
  "payload": {
    "reason": "barge_in"
  }
}
```

### 10. `error`

```json
{
  "type": "error",
  "sessionId": "sess_001",
  "turnId": "739251562187575296",
  "timestamp": "2026-04-20T02:30:00Z",
  "payload": {
    "code": "bad_message",
    "message": "Invalid JSON"
  }
}
```

### 11. `pong`

```json
{
  "type": "pong",
  "sessionId": "sess_001",
  "turnId": "739251562187575296",
  "timestamp": "2026-04-20T02:30:00Z",
  "payload": {
    "ok": true
  }
}
```

### 12. `rtc_start`

为当前控制面会话开启 RTC 媒体链路，并返回建链需要的 ICE server 列表：

```json
{
  "type": "rtc_start",
  "payload": {}
}
```

成功后服务端会下发：

```json
{
  "type": "rtc_session_ready",
  "sessionId": "sess_rtc_001",
  "turnId": null,
  "timestamp": "2026-04-28T10:30:00Z",
  "payload": {
    "sessionId": "sess_rtc_001",
    "iceServers": [
      {
        "urls": ["stun:stun.l.google.com:19302"]
      }
    ]
  }
}
```

### 13. `rtc_offer`

浏览器提交 SDP offer；服务端会异步返回 `rtc_answer`：

```json
{
  "type": "rtc_offer",
  "payload": {
    "sessionId": "sess_rtc_001",
    "type": "offer",
    "sdp": "v=0\r\n..."
  }
}
```

```json
{
  "type": "rtc_answer",
  "sessionId": "sess_rtc_001",
  "turnId": null,
  "timestamp": "2026-04-28T10:30:01Z",
  "payload": {
    "type": "ANSWER",
    "sdp": "v=0\r\n..."
  }
}
```

### 14. `rtc_ice_candidate`

服务端在 WebRTC 模式下通过控制面 WebSocket 下发新的 trickle ICE candidate，前端应将其追加到当前 `RTCPeerConnection`。

```json
{
  "type": "rtc_ice_candidate",
  "sessionId": "sess_rtc_001",
  "turnId": null,
  "timestamp": "2026-04-24T10:30:00Z",
  "payload": {
    "sdpMid": "0",
    "sdpMLineIndex": 0,
    "candidate": "candidate:1 1 UDP 1 127.0.0.1 3478 typ host"
  }
}
```

### 15. `rtc_close`

主动关闭当前控制面会话挂载的 RTC 运行态：

```json
{
  "type": "rtc_close",
  "payload": {
    "sessionId": "sess_rtc_001"
  }
}

### 16. `rtc_state_changed`

服务端在 WebRTC 会话生命周期内，会把关键运行态通过控制面 WebSocket 下发给前端，便于联调时判断问题卡在 signaling、ICE、媒体入站还是显式关闭：

```json
{
  "type": "rtc_state_changed",
  "sessionId": "sess_rtc_001",
  "turnId": null,
  "timestamp": "2026-04-29T07:30:00Z",
  "payload": {
    "state": "media_flowing",
    "source": "media",
    "detail": "first_audio_frame"
  }
}
```

当前约定的常见 `payload.state` 包括：

- `session_opened`：服务端已创建 RTC 会话，等待浏览器继续 offer / answer。
- `track_bound`：服务端已经收到并绑定浏览器远端音轨。
- `media_flowing`：第一帧 RTC 音频已经真正进入后端音频流水线。
- `connected`：ICE 或 PeerConnection 已进入可用连通态。
- `disconnected`：媒体链路暂时断开，前端可以按自身策略尝试恢复。
- `failed`：ICE 或 PeerConnection 进入失败态。
- `closed`：当前 RTC 会话已经关闭，`detail` 会给出关闭来源，例如 `rtc_close`、`peer_connection_failed`、`ice_closed`。
```

## 消息模型建议

建议所有 JSON 消息都遵循统一外壳：

```json
{
  "type": "state_changed",
  "sessionId": "sess_001",
  "turnId": "739251562187575296",
  "payload": {},
  "timestamp": "2026-04-20T02:30:00Z"
}
```

如果某条消息字段较少，可以直接平铺；如果后续需要扩展，`payload` 是更稳妥的兼容做法。

服务端 Java 下行模型中，`AgentEvent.payload` 使用事件专属实体类承载，例如
`StateChangedPayload`、`AsrFinalPayload`、`AgentTextChunkPayload`、`TtsAudioChunkPayload`
和 `ErrorPayload`。这些实体统一实现普通接口 `AgentEventPayload`，接口不使用 sealed
限制，业务方可以自定义 payload 实现类。事件外壳的必填字段仍由 `AgentEvent`
统一定义，该实现约束只影响后端构造事件的类型安全，序列化后的 JSON 字段形态仍保持本协议示例中的 `payload` 对象。

服务端 Java 上行模型中，`WsMessage.type` 使用字符串，`WsMessage.payload` 使用
`JsonNode`，以便自定义 type 在协议边界被策略注册表处理，而不是在 JSON 反序列化阶段失败。

## 运行时规则

1. `partial transcript` 只能推进状态，不能触发 LLM；Qwen ASR Realtime 可下发真实 partial，但只有最终 `asr_final` 能提交用户 turn。
2. 音频输入下，VAD 发现静音候选后可以通过 EOU 判断是否提交；EOU 只影响提交时机，不改变消息结构。
3. `turn committed` 是 LLM 启动边界。
4. TTS 只能消费当前有效 `turnId`，服务端通过字符串相等性隔离当前 turn。
5. 用户重新开口时，旧 turn 必须立即失效。
6. 当前默认扩展对接 Qwen ASR Realtime 和 Qwen TTS；可选 OpenAI ASR 扩展仍可通过 Spring Bean 或依赖组合替换。API Key 缺失、服务不可用或返回空音频时明确失败，不回退到假转写或假音频。
7. `text` 上行消息直接创建 committed turn，不经过 ASR partial 阶段，但仍必须等到该提交边界后才能启动 LLM/TTS。
8. WebRTC 首版只迁移音频面；控制面与 signaling 都必须使用现有 WebSocket JSON 语义。
9. `rtc_state_changed` 只用于联调、可观测性和恢复辅助，不改变原有 `rtc_session_ready`、`rtc_answer`、`rtc_ice_candidate` 的协议职责。
10. WebSocket token 只在当前进程内存中校验；服务重启、token 缺失或 token 无效时，客户端必须重新登录后再连接。
11. 控制面重连时允许复用既有 `sessionId`，用于把新的 WebSocket 重新绑定到同一业务会话；首次建链不要求客户端预先携带该参数。
12. `turn_metrics` 的“说完话”统计起点统一按当前 turn committed 边界计算；音频输入对应 `asr_final` 时刻，文本输入对应服务端接收并提交该文本的时刻。

LLM/TTS 位于异步下游回调中，运行期失败必须转换为下行 `error` 事件，不能让异常继续冒泡到 Reactor 订阅线程。当前 TTS 合成失败使用 `code=tts_failed`，LLM 启动或同步调用失败使用 `code=llm_failed`；客户端收到这类错误后应结束当前 turn 的思考或播放状态，并等待用户重新输入。

LLM 文本可以继续按 token 或短片段流式下发 `agent_text_chunk`。当前流水线会把每个非空 LLM 文本片段提交给 TTS；默认 Qwen TTS Realtime 适配器会按 turnId 累计文本，遇到句子边界或最后一个 chunk 后再启动合成，一次合成可能通过多个 `response.audio.delta` 下发多个音频块。

## Qwen ASR / Qwen TTS 验证流程

默认 ASR 使用 DashScope Java SDK 连接阿里云百炼 Qwen-ASR-Realtime，默认 TTS 使用 DashScope Java SDK 连接 Qwen-TTS-Realtime。启动应用前先配置：

```bash
export DASHSCOPE_API_KEY=sk-xxxx
```

Windows PowerShell：

```powershell
$env:DASHSCOPE_API_KEY="sk-xxxx"
```

默认示例配置会访问 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`。如果需要切换模型、地域端点或音色，修改 `kong-voice-agent.asr.qwen.*` 和 `kong-voice-agent.tts.qwen.*`。

如果业务模块启用 `kong-voice-extension-asr-qwen`，Qwen ASR 会为每个音频 turn 建立 DashScope SDK 实时识别会话，音频分片通过 `appendAudio` 追加，turn commit 时默认调用 `commit()` 和 `endSession()` 等待最终稿；返回结果仍按本协议下发 `asr_partial` / `asr_final`，不新增客户端消息字段。首个语音 turn 创建时，服务端会把预滚音频窗口一并送入 ASR，避免 VAD 确认说话的延迟截掉短句开头。当前接入 DashScope Java SDK 2.22.17 时，手动提交模式会显式把 `turn_detection` 下发为 `null`，避免 SDK 默认 `server_vad` 提前结束会话。若 completed 事件文本为空但此前已有 partial，实现会使用最近 partial 作为最终稿；若上游在最终稿之后追加 `connection.closed(code=1000)`，实现会按正常会话关闭处理；每个实时连接同时绑定独立代次，上一轮延迟到达的关闭或转写事件会被丢弃，不能污染下一轮；若 SDK 清理阶段抛出 `conversation is already closed!`，实现同样按幂等关闭处理，不会把这类收尾信号当成识别失败。

1. 调用 `POST /api/auth/login` 获取 token
2. 连接 `/ws/agent?token=<login-token>`
3. 发送 `audio_chunk`
4. 观察 `state_changed` 到 `USER_SPEAKING`
5. 发送 `audio_end` 或等待端点提交
6. 观察 `asr_final`
7. 观察 `agent_thinking`
8. 观察 `agent_text_chunk`
9. 观察 `tts_audio_chunk`
10. 观察 `turn_metrics`
10. 在 agent speaking 时发送第二轮 `audio_chunk` 或 `interrupt`
11. 观察 `playback_stop` 和 `turn_interrupted`

## 文本验证流程

1. 调用 `POST /api/auth/login` 获取 token
2. 连接 `/ws/agent?token=<login-token>`
3. 发送 `text`
4. 观察 `state_changed` 到 `USER_TURN_COMMITTED`
5. 观察 `asr_final`，其中 `payload.source` 为 `text`
6. 观察 `agent_thinking`
7. 观察 `agent_text_chunk`
8. 观察 `tts_audio_chunk`
9. 观察 `turn_metrics`

## 前端联调界面

面向前端接入的字段说明、状态建议和调试步骤维护在 `docs/frontend-integration.md`。仓库根目录的 `ui/` React 界面提供当前前端联调入口，流程是先登录，再按需要选择 `WS PCM` 或 `WebRTC`：前者直接连接 `/ws/agent?token=<login-token>` 并发送麦克风 PCM，后者同样先连接 `/ws/agent?token=<login-token>`，再通过 `rtc_start`、`rtc_offer` 和 `rtc_ice_candidate` 完成 signaling，同时通过 `RTCPeerConnection` 建立音频面。一个前端对话对应一个后端 session，点击“新对话”会建立新的会话，已有在线会话连接不会被关闭；React UI 会把会话列表和消息快照保存到浏览器 `localStorage`，切换会话时按前端会话 id 找回仍在线的 WebSocket 或展示本地快照。

## 不支持项

本版本不支持 `preemptive`，因此协议里不会定义“在 turn commit 之前提前生成回答”的消息语义。所有生成动作都必须等到 turn commit 之后再发生。
