# 前端对接说明

这份文档面向 Web 前端联调，说明如何连接 voice agent 后端、发送文本或音频、处理下行事件，以及如何使用 `ui/` React 界面做手工验证。

仓库根目录的 `ui/` 已提供新的 React 对话界面，使用 React 19、TypeScript 5.9、Vite 7、React Router 7、Shadcn UI / Radix UI、Tailwind CSS 4、Lucide React 和 pnpm。该界面参考豆包聊天页采用产品化 AI 对话布局：左侧为轻量会话栏，包含新对话、历史摘要、连接状态和账号入口；右侧为聚焦聊天区，首屏展示欢迎态和示例问题，底部固定输入框使用同一个主按钮支持文本发送和打断，空闲时显示发送，发送后立即切换为打断；顶部可切换 `WS PCM` 与 `WebRTC` 传输模式。切换模式时，前端会同步更新当前会话的传输模式、关闭旧的音频运行态，并在当前会话已经在线时按新模式自动重连，避免麦克风按钮命中错误的采集分支。`WS PCM` 模式下，输入框左侧麦克风按钮会建立电话式连续通话：浏览器持续保留麦克风流并把当前聆听阶段的音频重采样为 16kHz 单声道 PCM16，通过 WebSocket 二进制帧发送；VAD 提交本轮后只暂停上传而不释放麦克风，Agent 思考及 TTS 播放结束后自动恢复下一轮聆听，再次点击按钮才结束通话。`WebRTC` 模式下，页面会先创建 RTC 会话、再通过 `RTCPeerConnection` 发送麦克风音轨，按钮只负责静音/恢复本地音轨，并在静音时发送一次 `audio_end`。收到 `tts_audio_chunk` 后会按 `turnId` 入队播放，并在对应助手文字区域展示播报动效；WebRTC 模式下同时会消费远端 RTC 音轨作为主播放链路。当前版本会在聊天区顶部固定展示一个指标面板，并在每轮结束后用最近一次 `turn_metrics` 刷新面板内容，直接展示 ASR / LLM / TTS 响应耗时、总耗时，以及“说完话到 LLM 首字 / TTS 首包”的时延；聊天流里的系统摘要仍会保留，方便回看。React UI 中一个前端对话对应一个后端 session；点击“新对话”会创建新的前端会话，已有在线会话不会被关闭，切换会话时会复用仍在线的连接。会话列表、当前选中会话、消息快照、`sessionId`、最近 `turnId` 和最近一次指标面板快照会保存到浏览器 `localStorage`，刷新页面后可回看本地历史。控制面重新连接时，前端会优先把本地保存的 `sessionId` 带回 WebSocket 握手 query，恢复到原后端会话；RTC 媒体面进入 `disconnected` 或 `failed` 后，界面会按退避策略自动尝试最多 3 次恢复当前 RTC 链路。当前版本新增消费后端 `rtc_state_changed`，会把建链、收轨、首包音频、断流、失败和关闭这些关键节点映射到连接错误、麦克风状态和播放状态提示里。

## 接入信息

| 项 | 值 |
| --- | --- |
| 登录接口 | `POST http://localhost:9877/api/auth/login` |
| 默认固定账号 | `demo` / `demo123456` |
| WebSocket 地址 | `ws://localhost:9877/ws/agent?token=<login-token>` |
| WebRTC signaling | WebSocket `rtc_start`、`rtc_offer`、`rtc_ice_candidate`、`rtc_close`，以及下行 `rtc_session_ready`、`rtc_answer`、`rtc_ice_candidate`、`rtc_state_changed` |
| JSON 消息方向 | 客户端到服务端、服务端到客户端 |
| 音频消息方向 | `WS PCM` 模式下客户端以 WebSocket 二进制帧发送 PCM；`WebRTC` 模式下客户端以 RTC 音轨发送音频 |
| 音频格式 | 默认 16kHz / mono / 16-bit PCM little-endian，需与服务端 `kong-voice-agent.audio` 配置一致 |
| 推荐音频分片 | 默认 20ms，约 640 bytes |
| 文本入口 | `{"type":"text","payload":{"text":"..."}}` |

服务端以每个业务 `sessionId` 创建一个独立 session。纯 `WS PCM` 模式下，首次连接时前端无需在握手和上行消息里传 `sessionId`；如果需要把新的控制面连接重新绑定到原会话，可以在 WebSocket 握手 query 里追加该值。`WebRTC` 模式下，同样先建立控制面 WebSocket，再在该连接对应的同一个 `sessionId` 上发送 `rtc_start` 挂载 RTC 媒体链路。前端必须在下行消息里按 `sessionId` 和 `turnId` 维护显示、播放和过期消息丢弃逻辑。`turnId` 创建后是服务端雪花 ID 字符串，连接刚建立且尚未创建用户 turn 时可能为 `null`；前端只应做字符串相等性判断。JSON 上行消息按字符串 `type` 进入服务端策略注册表，内置支持 `ping`、`interrupt`、`audio_end`、`text`、`rtc_start`、`rtc_offer`、`rtc_ice_candidate` 和 `rtc_close`；业务后端可以新增自定义 type，但不能覆盖这些内置 type。

前端接入顺序固定为：

1. 调用 `POST /api/auth/login`，用固定账号换取 `token`。
2. 选择传输模式：
   - `WS PCM`：用 `ws://localhost:9877/ws/agent?token=<login-token>` 建立 WebSocket。
   - `WebRTC`：先用 `ws://localhost:9877/ws/agent?token=<login-token>` 建立控制面 WebSocket，再在该连接上发送 `rtc_start`、`rtc_offer` 和 `rtc_ice_candidate` 完成 signaling，同时通过 `RTCPeerConnection` 建立音频面。
3. 连接成功后再发送 `ping`、`text`、`audio_end`、`interrupt` 或音频数据。

当前 token 只保存在服务端进程内存中。后端重启、token 丢失或握手返回 401 时，前端需要重新登录后再连接；不要把 token 当作长期凭据缓存。

## 快速验证

1. 启动后端：

```bash
mvn -pl kong-voice-agent-app -am package
java -jar kong-voice-agent-app/target/kong-voice-agent-app-0.1.jar
```

2. 启动 React UI：

```bash
cd ui
pnpm install
pnpm dev
```

3. 访问 `http://localhost:5173/`。
4. 使用默认账号 `demo` / `demo123456` 登录。
5. 登录成功后，按需要切换 `WS PCM` 或 `WebRTC`，再在左侧连接状态区点击连接。
6. 发送文本 `你好，介绍一下你自己`。
7. 确认页面展示用户气泡、助手流式文本和 TTS 播报动效；如果是 `WebRTC` 模式，还应看到浏览器麦克风授权成功并建立远端音轨。
8. 点击“新对话”后应看到新的后端 session 建立，旧会话连接保持在线。
9. 刷新浏览器页面，确认左侧仍能看到本地保存的历史会话和消息快照。

后端默认会把音频 turn 提交到 Qwen ASR Realtime，并把 Agent 文本提交到 Qwen TTS。启动应用前需要设置 `DASHSCOPE_API_KEY` 或 `KONG_VOICE_AGENT_QWEN_API_KEY`。前端仍然只消费相同的 `asr_partial` / `asr_final` 协议；服务不可用、API Key 缺失或返回空音频时会明确失败，不再回退到假数据；TTS 失败会下发 `error(code=tts_failed)`，前端应结束当前 turn 的思考或播放状态。

### React UI 验证

新的 React UI 适合日常文本对话联调：

```bash
cd ui
pnpm install
pnpm dev
```

访问：

```text
http://localhost:5173/
```

默认环境变量位于 `ui/.env.example`：

```text
VITE_AGENT_HTTP_BASE=http://localhost:9877
VITE_AGENT_WS_BASE=ws://localhost:9877
```

如果后端端口或域名不同，复制为 `ui/.env.local` 后修改。当前 React UI 已实现固定账号登录、`WS PCM / WebRTC` 传输模式切换、WebSocket 控制面连接、`ping`、`text`、`interrupt`、麦克风 PCM 二进制上传、RTC signaling、停止录音自动 `audio_end`、`asr_final` 用户气泡、`agent_thinking`、`agent_text_chunk` 聚合显示、`tts_audio_chunk` 播放队列和播报动效、`turn_metrics` 摘要展示，以及聊天区顶部固定指标面板，并按 `turnId` 更新当前会话；“新对话”会建立新的后端 session，同时保留其他会话已建立的连接。历史会话只作为浏览器本地快照存储在 `localStorage`，切换历史项时如果对应连接仍在线会继续复用。

## 上行消息

### 登录

WebSocket 连接前必须先登录。固定账号默认值来自后端配置：

| 配置项 | 默认值 | 环境变量 |
| --- | --- | --- |
| `kong-voice-agent.auth.fixed-user.account-id` | `123456` | `KONG_VOICE_AGENT_AUTH_FIXED_USER_ACCOUNT_ID` |
| `kong-voice-agent.auth.fixed-user.username` | `demo` | `KONG_VOICE_AGENT_AUTH_FIXED_USER_USERNAME` |
| `kong-voice-agent.auth.fixed-user.password` | `demo123456` | `KONG_VOICE_AGENT_AUTH_FIXED_USER_PASSWORD` |

请求：

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

随后连接控制面：

```js
const socket = new WebSocket(`ws://localhost:9877/ws/agent?token=${encodeURIComponent(login.token)}`);
```

如果走 WebRTC 模式，需要在控制面 WebSocket 已经连接后，通过该连接继续发起 signaling：

```ts
const socket = new WebSocket(`ws://localhost:9877/ws/agent?token=${encodeURIComponent(login.token)}`);
```

### WebRTC signaling

首版 WebRTC 只负责音频面，控制消息和 signaling 都走现有 WebSocket：

```ts
const rtcSession = await createRtcSession(socket);
const offer = await peerConnection.createOffer();
await peerConnection.setLocalDescription(offer);
const answer = await submitRtcOffer(socket, rtcSession.sessionId, {
  type: offer.type,
  sdp: offer.sdp ?? "",
});
await peerConnection.setRemoteDescription(answer);
```

本地 ICE candidate 通过 `rtc_ice_candidate` 文本消息上送；服务端新增的 candidate 会通过下行同名 `rtc_ice_candidate` 事件回推给前端。除此之外，服务端还会通过 `rtc_state_changed` 暴露 `session_opened`、`track_bound`、`media_flowing`、`connected`、`disconnected`、`failed` 和 `closed` 等运行态，前端可以据此更新调试提示或恢复策略。

### 文本对话

文本输入会直接创建一个已提交的用户 turn，跳过 VAD/ASR partial 阶段，随后进入 LLM/TTS。

```json
{
  "type": "text",
  "payload": {
    "text": "你好，介绍一下你自己"
  }
}
```

### 心跳

```json
{
  "type": "ping",
  "payload": {
    "ts": 1776657600000
  }
}
```

服务端返回 `pong`：

```json
{
  "type": "pong",
  "sessionId": "sess_001",
  "turnId": null,
  "timestamp": "2026-04-20T02:30:00Z",
  "payload": {
    "ok": true
  }
}
```

### 主动打断

```json
{
  "type": "interrupt",
  "payload": {
    "reason": "client_interrupt"
  }
}
```

当前实现会以服务端固定原因 `client_interrupt` 处理打断。前端可保留 `payload.reason` 作为本地日志字段，但不要依赖服务端逐字回传该值。

### 音频结束

```json
{
  "type": "audio_end",
  "payload": {}
}
```

音频流结束后，服务端会尝试提交当前音频 turn 并输出 final transcript。

### PCM 二进制帧

麦克风输入需要转换为服务端 `kong-voice-agent.audio` 配置的 PCM 格式，并通过 WebSocket 二进制消息发送。默认配置是 16kHz 单声道 PCM16 little-endian。

服务端启用 EOU 后，短暂停顿不一定立即产生 `asr_final`：VAD 会先进入静音候选，EOU 可结合流式 ASR partial 文本判断用户是否真的说完。Qwen ASR Realtime 可产生真实 `asr_partial`，但前端仍应兼容只收到 `state_changed` 和 `asr_final` 的流程；后端在首个语音 turn 创建时会把预滚音频一并送入 ASR，降低短句开头被 VAD 延迟截断后产生空转写的概率。当收到 `USER_TURN_COMMITTED`、`AGENT_THINKING` 或 `AGENT_SPEAKING` 时，`WS PCM` 模式前端应停止继续上传当前轮的麦克风音频。调试时可关注 `state_changed.payload.reason` 中的 `eou_detected`、`eou_waiting`、`eou_max_silence_fallback` 和 `eou_unavailable_fallback`。

```js
socket.send(pcmArrayBuffer);
```

前端实现建议：

- 使用 `navigator.mediaDevices.getUserMedia({ audio: true })` 获取麦克风。
- 使用 `AudioContext` 读取 Float32 PCM。
- 将输入采样率重采样到 16000Hz。
- 将 Float32 范围 `[-1, 1]` 裁剪并写入 `Int16Array`。
- 每 20ms 左右发送一个二进制分片。
- 如果后端修改了 `sample-rate`、`channels` 或 `upload-chunk-ms`，前端需要同步修改重采样、混音和分片参数；当前 WebSocket 协议不会自动协商这些值。

## 下行消息

所有 JSON 下行消息都使用统一外壳：

```json
{
  "type": "agent_text_chunk",
  "sessionId": "sess_001",
  "turnId": "739251562187575296",
  "timestamp": "2026-04-20T02:30:00Z",
  "payload": {}
}
```

前端应按 `type` 分发事件，并按字符串 `turnId` 处理 UI 与播放队列。

| 类型 | 用途 | 前端建议 |
| --- | --- | --- |
| `state_changed` | 状态切换 | 更新会话状态、调试状态条 |
| `asr_partial` | 流式中间转写 | 只展示临时字幕，不触发业务提交 |
| `asr_final` | 最终用户输入 | 固化用户气泡或转写结果 |
| `agent_thinking` | Agent 开始生成 | 展示思考中状态 |
| `agent_text_chunk` | Agent 文本片段 | 按 `seq` 追加到当前 Agent 气泡 |
| `tts_audio_chunk` | Agent 音频片段 | 按 `seq` 播放或排队；mock 音频仅用于链路验证 |
| `turn_metrics` | 当前 turn 的阶段耗时指标 | 适合展示调试摘要，或写入埋点 / 联调日志 |
| `rtc_ice_candidate` | WebRTC trickle ICE candidate | 只在 `WebRTC` 模式消费，追加到当前 `RTCPeerConnection` |
| `rtc_state_changed` | WebRTC 运行态变化 | 更新连接错误、麦克风状态、播放状态和恢复调试提示 |
| `playback_stop` | 停止旧播报 | 清空当前播放队列 |
| `turn_interrupted` | 旧 turn 被打断 | 标记旧 turn 失效 |
| `error` | 协议或运行错误 | 展示错误并写入日志；`tts_failed` 表示 Qwen TTS 或自定义 TTS 服务不可用、鉴权失败或返回空音频 |
| `pong` | 心跳响应 | 更新连接延迟或在线状态 |

## turnId 处理规则

`turnId` 是前端处理并发与打断的关键字段。

1. 前端收到不同的非空 `turnId` 后，应把旧 turn 的临时字幕、思考中状态和待播放音频视为过期。
2. 对于 `agent_text_chunk` 和 `tts_audio_chunk`，只追加或播放当前有效 `turnId` 的内容，不要按数值大小比较。
3. 收到 `playback_stop` 或 `turn_interrupted` 时，应立即停止旧音频并清理队列。
4. `asr_partial` 只能展示为临时状态，不能当作最终用户输入提交给 UI 业务层。

## TTS 播放建议

`tts_audio_chunk.payload.audioBase64` 是后端 TTS 返回字节的 base64 编码。当前应用默认调用 Qwen TTS Realtime，联调台会优先尝试 `AudioContext.decodeAudioData`；如果后端返回裸 PCM，联调台才会按 PCM16 little-endian 和播放区采样率兜底播放。

后端流水线会把每个非空 `agent_text_chunk` 提交给 TTS。当前 Qwen TTS Realtime 适配器会先按 turnId 累计片段，遇到句子边界或最后一个 chunk 后再合成；一次合成可能通过多个 `response.audio.delta` 产生多个音频块。因此前端应继续按 `seq` 排队播放，不要假设文本 chunk 和音频 chunk 一一对应。

前端播放逻辑需要遵守：

- 只播放当前有效 `turnId` 的 `tts_audio_chunk`。
- 收到 `playback_stop`、`turn_interrupted` 或用户主动发送 `interrupt` 后，立即停止当前音频节点并清空待播放队列。
- `seq` 只用于同一个 turn 内排序，不用于跨 turn 比较。
- 如果 TTS PCM 采样率和联调台默认值不同，需要在播放区同步修改采样率；当前协议没有下发音频格式元数据。

`ui/` React 界面已实现上述逻辑，可作为真实前端的参考行为：页面按 `turnId` 聚合文本、过滤过期音频，并在切换 turn、打断或新建会话时清理旧播放队列。

## 推荐前端状态模型

```ts
type AgentRuntimeState =
  | "DISCONNECTED"
  | "CONNECTED"
  | "USER_SPEAKING"
  | "USER_TURN_COMMITTED"
  | "AGENT_THINKING"
  | "AGENT_SPEAKING"
  | "INTERRUPTED";

interface AgentEventEnvelope<T = Record<string, unknown>> {
  type: string;
  sessionId: string;
  turnId: string | null;
  timestamp: string;
  payload: T;
}
```

前端不需要完全复刻服务端状态机，但建议至少维护：

- `connected`：WebSocket 是否连接。
- `sessionId`：最近一次下行事件携带的 session。
- `currentTurnId`：当前有效 turn。
- `partialText`：正在变化的 ASR 临时文本。
- `finalUserText`：已提交用户文本。
- `agentText`：当前 Agent 文本聚合。
- `audioQueue`：当前 turn 的 TTS 音频队列。

`ui/` 的 React 实现当前使用组件级 `useState` 管理登录态、按前端会话隔离的连接态、当前 `sessionId`、当前 `turnId`、消息列表和历史摘要，不引入全局状态库。一个前端对话对应一个后端 session；浏览器本地通过 `localStorage` 保存历史会话快照，key 为 `kong-voice-agent.conversations.v1` 和 `kong-voice-agent.active-conversation.v1`。当前实现已额外维护 `transportKind = "ws-pcm" | "webrtc"` 与每会话独立的 RTC 运行态；`webrtc` 模式下，会话仍保留控制面 WebSocket，但 TTS 主播放链路改为远端 RTC 音轨。后续如果接入真实服务端会话列表，应继续保持按 `sessionId` 和 `turnId` 隔离 UI 更新，并在切换会话时复用仍在线的连接或为离线会话重新连接。

`turn_metrics` 建议使用方式：

- `payload.stage=tts_completed` 或 `llm_completed` 时，可认为当前轮主要耗时已经收口，适合展示最终摘要。
- `payload.source=audio` 时，`asrResponseLatencyMs` 和 `asrDurationMs` 才有值；文本输入 turn 这些字段会缺省。
- `speechEndToLlmFirstTokenMs` 与 `speechEndToTtsFirstChunkMs` 的起点统一是当前轮 `turn committed`，音频输入近似“用户说完话”，文本输入则是服务端接收并提交文本的时刻。

## JavaScript 最小示例

```js
const loginResponse = await fetch("http://localhost:9877/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "demo", password: "demo123456" })
});

if (!loginResponse.ok) {
  throw new Error("登录失败，无法建立 WebSocket");
}

const login = await loginResponse.json();
const socket = new WebSocket(`ws://localhost:9877/ws/agent?token=${encodeURIComponent(login.token)}`);

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ type: "ping", payload: { ts: Date.now() } }));
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  switch (message.type) {
    case "asr_partial":
      renderPartial(message.payload.text);
      break;
    case "asr_final":
      renderUserText(message.payload.text);
      break;
    case "agent_text_chunk":
      appendAgentText(message.turnId, message.payload.text);
      break;
    case "playback_stop":
    case "turn_interrupted":
      stopPlayback(message.turnId);
      break;
    default:
      logEvent(message);
  }
});

function sendText(text) {
  socket.send(JSON.stringify({ type: "text", payload: { text } }));
}
```

## 错误处理

常见错误：

- HTTP 401：登录账号或密码错误，或 WebSocket 握手缺少有效 token。
- `bad_message`：JSON 格式错误、缺少 `type`、缺少 `payload.text`。
- WebSocket 断开：前端应停止采集麦克风并禁用发送按钮。
- 音频格式错误：服务端按 `kong-voice-agent.audio` 配置处理 PCM，前端必须完成对应的重采样、声道处理和 PCM16 转换。
- 后端重启：内存 token 全部失效，前端需要重新登录并重建 WebSocket。

建议前端把最近 100 条事件保留在调试日志里，联调时按时间、`type`、`turnId` 和 `payload` 排查。

## 联调验收清单

- [ ] `POST /api/auth/login` 可以使用固定账号拿到 token。
- [ ] WebSocket 使用 `?token=<login-token>` 可以连接并收到初始 `state_changed(IDLE)`。
- [ ] 缺少 token 或 token 无效时 WebSocket 握手返回 401。
- [x] 开启 `KONG_VOICE_AGENT_RTC_ENABLED=true` 后，可以通过 `rtc_start` 收到 `rtc_session_ready`。
- [x] `WebRTC` 模式下，控制面 WebSocket 无需重连或追加 `sessionId` query，即可在当前会话上完成 signaling。
- [x] `rtc_ice_candidate` 事件可以被前端正确追加到 `RTCPeerConnection`。
- [x] `rtc_state_changed` 可以反映 `session_opened`、`track_bound`、`media_flowing`、断流、失败和关闭等关键调试节点。
- [x] 控制面重连时带回历史 `sessionId` 后，可以重新绑定到原后端会话。
- [x] RTC 媒体面进入 `disconnected` 或 `failed` 后，前端会自动尝试恢复当前会话的 RTC 链路。
- [ ] `ping` 能收到 `pong`。
- [ ] 文本输入能收到 `asr_final(source=text)`。
- [ ] Agent 文本能按 chunk 聚合显示。
- [ ] `interrupt` 能触发旧 turn 停止。
- [ ] 麦克风输入能在 `audio_end` 或端点提交后产生 `asr_final`。
- [ ] `audio_end` 后能产生 `asr_final(source=audio)`。
- [ ] 收到新 `turnId` 后旧音频不会继续播放。
- [ ] React UI 可以通过 `pnpm dev` 启动，默认访问 `http://localhost:5173/`。
- [ ] React UI 可以登录、切换 `WS PCM / WebRTC`、连接、发送文本、聚合 Agent 文本 chunk、自动播放 TTS 或远端 RTC 音轨、展示播报动效，并切换日间/夜间主题。
- [ ] React UI 点击“新对话”后会建立新的 WebSocket，下行 `sessionId` 应变为新的后端 session，旧会话连接不应被关闭。
- [ ] React UI 刷新页面后能从 `localStorage` 恢复会话列表和消息快照。
