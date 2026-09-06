# Kong Voice Agent

Kong Voice Agent 是一个面向生产场景设计的 Java Voice Agent 后端框架，基于 Java 21、Spring Boot 3、WebSocket 和首版 WebRTC 音频接入实现，支持文本输入、WebSocket PCM 音频输入、WebRTC 音轨输入，内置 Session 与 turnId 隔离、VAD、流式 ASR、LLM、TTS、打断流程和 React 前端联调界面。

项目围绕可替换能力接口设计，业务侧可以自定义接入 ASR、LLM、TTS、VAD 等真实服务；当前版本同时提供可独立运行的 mock 闭环，便于快速验证协议、状态机和前后端联调流程。

## 当前能力

- 登录接口：`POST http://localhost:9877/api/auth/login`，默认固定账号为 `demo` / `demo123456`
- WebSocket 端点：`ws://localhost:9877/ws/agent?token=<login-token>`，连接前必须先登录获取 token
- WebRTC 信令：复用 `/ws/agent` 控制面 WebSocket，内置 `rtc_start`、`rtc_offer`、`rtc_ice_candidate`、`rtc_close` 上行消息，以及 `rtc_session_ready`、`rtc_answer`、`rtc_ice_candidate`、`rtc_state_changed` 下行消息；控制面重连时可携带历史 `sessionId` 复用同一后端会话
- 文本输入：直接发送 JSON 文本消息进入 Agent 回复链路
- 音频输入：默认发送 16kHz / mono / 16-bit PCM little-endian 二进制帧，格式可通过配置调整
- Session 隔离：每个业务 `sessionId` 拥有独立 session；默认 `WS PCM` 模式直接使用当前 WebSocket 会话，切换到 `WebRTC` 后在同一个控制面 session 上挂载 RTC 媒体链路
- Turn 隔离：所有异步结果通过雪花 ID 字符串 `turnId` 防止旧回复污染新对话
- 通用 ID：`IdUtils` 支持不可预测 session id 和趋势递增的雪花 ID
- VAD：优先加载 `models/silero_vad.onnx`，模型不可用时自动回退到 RMS fallback
- ASR / LLM / TTS：应用默认组合 `kong-voice-extension-*` 提供的 Qwen ASR Realtime、Qwen TTS 扩展与应用侧 LLM 实现，可通过 Spring Bean 替换；仓库内也提供可单独引入的 OpenAI ASR、OpenAI LLM 和 OpenAI TTS 扩展模块
- 链路指标：按 turn 输出 `turn_metrics`，可直接统计 ASR / LLM / TTS 响应时间、总耗时，以及“说完话到 LLM 首字 / TTS 首包”的时延
- HTTP / Realtime / SSE / JSON：OpenAI ASR、Qwen ASR、应用侧 AgentScope LLM、OpenAI LLM 扩展、OpenAI TTS、Qwen TTS 和项目协议 JSON 工具统一复用 `kong-http` 与 DashScope Java SDK 提供的请求、实时 WebSocket 和 JSON 能力
- 打断：支持客户端主动 `interrupt`，也支持 Agent 播报中用户重新说话触发打断
- React UI：`ui/` 使用 React 19、TypeScript 5.9、Vite 7、React Router 7、Shadcn UI / Radix UI、Tailwind CSS 4、Lucide React 和 pnpm，提供豆包风格的产品化聊天界面、轻量会话侧栏、移动端覆盖式侧栏、底部固定输入、`WS PCM / WebRTC` 传输模式切换、发送/打断一体主按钮、电话式连续通话、TTS 自动播放和文字区播报动效；每个前端会话拥有独立控制面 WebSocket，多个会话连接可同时存在，切换会话不会断开其他在线会话；会话列表和消息快照会写入浏览器 `localStorage`

## 环境要求

| 工具 | 要求 |
| --- | --- |
| JDK | 21 或更高版本 |
| Maven | 3.9.0 或更高版本 |
| Node.js | 22 或更高版本 |
| pnpm | 10 或更高版本 |
| 浏览器 | Chrome、Edge 或其他支持 WebSocket 与麦克风权限的现代浏览器 |

确认本机环境：

```bash
java -version
mvn -version
node -v
pnpm -v
```

如果 Maven 构建提示 Java 或 Maven 版本不满足要求，请先升级对应工具。根工程已通过 Maven Enforcer 固化构建基线，避免低版本环境产生隐蔽问题。

应用模块引入 AgentScope 相关 BOM 时，会在模块内重新导入项目统一的 Spring Boot BOM，确保 Spring Boot、Spring Framework、Jackson 和 JUnit 等平台依赖仍跟随根工程的 `spring-boot.version`。如果启动期出现 `Could not find class [org.springframework.boot.thread.Threading]`，优先检查 `spring-boot` 与 `spring-boot-autoconfigure` 是否被业务 BOM 管理成了不同主版本。

## 3 分钟快速开始

### 1. 构建项目

在仓库根目录执行：

```bash
mvn clean package
```

只构建应用模块及其依赖时可以执行：

```bash
mvn -pl kong-voice-agent-app -am package
```

### 2. 启动后端

```bash
java -jar kong-voice-agent-app/target/kong-voice-agent-app-0.1.jar
```

启动成功后，默认监听端口为 `9877`，先用固定账号登录：

```bash
curl -X POST http://localhost:9877/api/auth/login -H "Content-Type: application/json" -d '{"username":"demo","password":"demo123456"}'
```

登录成功会返回本次登录的 `token`，例如：

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

WebSocket 地址需要把登录得到的 token 放到 query 参数中：

```text
ws://localhost:9877/ws/agent?token=<login-token>
```

如果走 WebRTC 首版音频链路，需要额外启用 RTC 配置；signaling 不再走独立 HTTP，而是复用控制面 WebSocket：

```text
上行：rtc_start / rtc_offer / rtc_ice_candidate / rtc_close
下行：rtc_session_ready / rtc_answer / rtc_ice_candidate / rtc_state_changed
```

### 3. 启动 React UI

新 UI 位于仓库根目录的 `ui/`，使用 pnpm 管理依赖：

```bash
cd ui
pnpm install
pnpm dev
```

默认访问：

```text
http://localhost:5173/
```

页面左侧是轻量会话栏，包含新对话、历史摘要、连接状态和账号入口；右侧是产品化聊天区，首屏会展示欢迎态和示例问题，底部固定输入框使用同一个主按钮负责发送和打断：空闲时显示发送，发送后立即切换为打断。使用默认账号 `demo` / `demo123456` 登录后，可以先在顶部选择 `WS PCM` 或 `WebRTC` 传输模式，再在左侧连接状态区点击连接。

- `WS PCM`：页面会通过 `ws://localhost:9877/ws/agent?token=<login-token>` 为当前会话建立 WebSocket，并继续使用浏览器本地重采样后的 PCM16 二进制帧上传麦克风音频。
- `WebRTC`：页面会先连接 `ws://localhost:9877/ws/agent?token=<login-token>`，随后在当前控制面 WebSocket 上发送 `rtc_start`、`rtc_offer` 和 `rtc_ice_candidate` 完成信令协商；麦克风音频改由 `RTCPeerConnection` 直传，TTS 通过远端 RTC 音轨回放；后端会额外通过 `rtc_state_changed` 暴露会话创建、远端音轨绑定、首包音频进入流水线、断流、失败和关闭等关键运行态。

点击“新对话”会创建新的前端会话并为它打开新的后端 session，不会关闭其他仍在线的会话连接。React UI 会把会话列表、当前选中会话、消息快照、`sessionId` 和最近 `turnId` 写入浏览器 `localStorage`，刷新页面后可回看本地历史；切换会话会恢复该会话的本地记录，并在连接仍在线时继续复用原 WebSocket 或 WebRTC 会话。控制面因刷新、断线或手动重连重新建立时，前端会优先带回本地保存的 `sessionId`，把同一对话重新绑定到原后端 session。顶部切换 `WS PCM / WebRTC` 时，会同步更新当前会话的传输模式、关闭旧的音频运行态，并在当前会话已经在线时按新模式自动重连，避免界面模式与真实连接不一致。`WS PCM` 模式下只需点击一次输入框左侧麦克风按钮即可开始连续通话：浏览器持续保留麦克风资源，VAD 检测到用户停顿后自动提交本轮；Agent 思考和本地 TTS 播放期间暂停 PCM 上传，回答播完后自动恢复下一轮聆听，用户再次点击按钮才会结束通话。这样既不需要每轮重新授权或点击，也可避免扬声器回声被识别成用户插话。`WebRTC` 模式下浏览器会直接维护麦克风音轨，按钮负责静音或恢复，并在静音时发送一次 `audio_end`。如果 RTC 媒体面进入 `disconnected` 或 `failed`，前端会按退避策略自动尝试最多 3 次恢复当前会话的 RTC 链路；同时页面会根据后端 `rtc_state_changed` 实时刷新“连接错误 / 麦克风状态 / 播放状态”这些调试提示。收到回复后可查看流式 Agent 文本、自动播放 TTS 音频或远端 RTC 音轨、在助手文字区查看播报动效，或切换日间/夜间主题。

React UI 默认读取：

```text
VITE_AGENT_HTTP_BASE=http://localhost:9877
VITE_AGENT_WS_BASE=ws://localhost:9877
```

如需修改后端地址，可复制 `ui/.env.example` 为 `ui/.env.local` 后调整。

## 最小 WebSocket 示例

前端或脚本需要先登录，再用返回的 token 建立 WebSocket 连接并发送 JSON 文本消息验证链路：

```js
const loginResponse = await fetch("http://localhost:9877/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "demo", password: "demo123456" })
});
const login = await loginResponse.json();
const socket = new WebSocket(`ws://localhost:9877/ws/agent?token=${encodeURIComponent(login.token)}`);

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({
    type: "text",
    payload: {
      text: "你好，介绍一下你自己"
    }
  }));
});

socket.addEventListener("message", (event) => {
  console.log(JSON.parse(event.data));
});
```

常用上行消息：

```json
{
  "type": "ping",
  "payload": {
    "ts": 1776657600000
  }
}
```

```json
{
  "type": "interrupt",
  "payload": {
    "reason": "client_interrupt"
  }
}
```

```json
{
  "type": "audio_end",
  "payload": {}
}
```

更多字段和事件示例见 [docs/protocol.md](docs/protocol.md)。

## 音频输入说明

服务端默认按以下格式处理 WebSocket 二进制音频帧，实际值来自 `kong-voice-agent.audio` 配置：

- 采样率：`16000Hz`
- 声道：`mono`
- 位深与字节序：`16-bit PCM little-endian`
- 推荐分片：`20ms`，约 `640 bytes`

前端采集麦克风时，需要把浏览器 `AudioContext` 的 Float32 音频重采样到 16kHz，并转换为 PCM16 little-endian 后再发送。仓库内的 `ui/` React 界面已包含这条验证路径，可以作为前端接入参考。后端会保留一小段开口前预滚音频，首个语音 turn 创建时会把预滚窗口一起送入 ASR，避免 VAD 确认说话的延迟截掉短句开头。若切换到 WebRTC 模式，浏览器不再通过 WebSocket 手工上传 PCM，而是把麦克风音轨通过 `RTCPeerConnection` 发送给后端；控制面 `text`、`interrupt`、`ping`、`error`、`state_changed` 和 RTC signaling 全部复用现有 WebSocket 协议。

React UI 也会消费 `tts_audio_chunk.payload.audioBase64` 并播放 TTS 音频。当前应用默认调用 Qwen TTS Realtime 扩展，并把 `response.audio.delta` 返回的 Base64 音频分片解码后作为 `tts_audio_chunk.payload.audioBase64` 下发；页面会优先尝试浏览器解码，如果后端返回裸 PCM，页面才会按 PCM16 little-endian 和播放区采样率兜底播放。

服务端还会在每轮关键阶段下发 `turn_metrics`，字段口径以服务端真实边界为准：音频 turn 的 ASR 指标从首个音频块进入流水线开始计时，`speechEndToLlmFirstTokenMs` 和 `speechEndToTtsFirstChunkMs` 统一从当前轮 turn committed 边界计算。`ui/` 页面会把最近一次完成轮次的指标固定显示在聊天区顶部的面板里，并在 `tts_completed` 时保留一条系统摘要，便于联调时快速观察首字时延、首包时延和整体耗时。

如果修改 `sample-rate`、`channels` 或 `upload-chunk-ms`，前端采集和重采样逻辑也要同步调整；当前服务端不会在 WebSocket 中做音频格式协商。

## 项目结构

```text
.
├── docs/
│   ├── architecture.md             # 模块分层和端到端数据流
│   ├── biz/                        # 业务领域文档目录
│   ├── features.md                 # 功能文档入口
│   ├── frontend-integration.md     # 前端接入和联调说明
│   ├── in-progress.md              # 当前正在开发中的功能
│   ├── plan/                       # 正在开发功能的步骤计划目录
│   ├── protocol.md                 # WebSocket 协议、事件和示例
│   ├── roadmap.md                  # 后续计划
│   ├── topic/                      # 通用主题文档目录
│   └── system-state.md             # 已完成并稳定可用的功能
├── kong-voice-agent-core/          # 可复用语音流水线、WS 协议骨架、协议模型、扩展接口
├── kong-voice-extension/           # 扩展模块聚合
│   ├── kong-voice-extension-asr-openai/  # OpenAI ASR 扩展
│   ├── kong-voice-extension-asr-qwen/    # Qwen ASR 扩展
│   ├── kong-voice-extension-llm-openai/  # OpenAI LLM 扩展（当前 app 默认未引入）
│   ├── kong-voice-extension-eou-livekit/ # LiveKit 风格 EOU 扩展
│   ├── kong-voice-extension-vad-silero/  # Silero VAD + ONNX Runtime 扩展
│   ├── kong-voice-extension-tts-openai/  # OpenAI TTS 扩展（当前 app 默认未引入）
│   ├── kong-voice-extension-tts-qwen/    # Qwen TTS 扩展
│   └── kong-voice-extension-transport-webrtc/ # WebRTC 传输扩展
├── kong-voice-agent-app/           # Spring Boot 启动入口、配置和应用侧装配
├── ui/                             # React 19 + Vite 7 + Tailwind CSS 4 对话界面
├── models/                         # 外置模型目录，默认查找 silero_vad.onnx
├── pom.xml                         # Maven 多模块根工程
└── README.md
```

各模块职责：

- `kong-voice-agent-core`：承载 Session、TurnManager、EOU 抽象、默认 WebSocket 处理器、协议模型、ASR / VAD / LLM / TTS 抽象和 `VoicePipelineHook`，协议 JSON 序列化入口复用 `kong-http` 的 JSON 门面。
- `kong-voice-extension-asr-openai`：承载 OpenAI ASR 自动配置，默认实现使用 `kong-http` 调用 `/audio/transcriptions`。
- `kong-voice-extension-asr-qwen`：承载 Qwen ASR Realtime 自动配置，显式启用后使用 DashScope Java SDK 连接百炼实时识别 WebSocket，把 PCM 分片以 Base64 追加到实时会话。
- `kong-voice-extension-llm-openai`：承载 OpenAI LLM 自动配置，默认实现使用 `kong-http` SSE 调用 `/chat/completions` 输出文本 chunk；当前 app 默认未引入该模块。
- `kong-voice-extension-eou-livekit`：承载默认 LiveKit MultilingualModel 风格 EOU 自动配置和 ONNX detector。
- `kong-voice-extension-vad-silero`：承载默认 Silero VAD、`kong-voice-agent.vad.*` / `kong-voice-agent.onnx.*` 配置绑定和 ONNX Runtime 会话工厂。
- `kong-voice-extension-tts-openai`：承载 OpenAI TTS 自动配置，默认实现使用 `kong-http` 调用 `/audio/speech`；当前 app 默认未引入该模块。
- `kong-voice-extension-tts-qwen`：承载 Qwen TTS Realtime 自动配置，默认实现使用 DashScope Java SDK 连接百炼实时语音合成 WebSocket，解析 `response.audio.delta` Base64 音频分片并回传给流水线。
- `kong-voice-agent-app`：承载 Spring Boot 应用入口、`/ws/agent` 注册、运行配置、默认扩展组合和 LLM 实现；应用侧 AgentScope 模型传输通过 `KongHttpTransport` 适配到 `kong-http`。

## 配置入口

默认配置位于：

```text
kong-voice-agent-app/src/main/resources/application.yml
```

关键默认值：

```yaml
server:
  port: 9877

kong-voice-agent:
  auth:
    fixed-user:
      account-id: ${KONG_VOICE_AGENT_AUTH_FIXED_USER_ACCOUNT_ID:123456}
      username: ${KONG_VOICE_AGENT_AUTH_FIXED_USER_USERNAME:demo}
      password: ${KONG_VOICE_AGENT_AUTH_FIXED_USER_PASSWORD:demo123456}
  onnx:
    gpu-enabled: ${KONG_VOICE_AGENT_ONNX_GPU_ENABLED:false}
    gpu-device-id: ${KONG_VOICE_AGENT_ONNX_GPU_DEVICE_ID:0}
    fallback-to-cpu: ${KONG_VOICE_AGENT_ONNX_FALLBACK_TO_CPU:false}
  audio:
    sample-rate: 16000
    channels: 1
    sample-format: s16le
    upload-chunk-ms: 20
  asr:
    qwen:
      enabled: ${KONG_VOICE_AGENT_ASR_QWEN_ENABLED:true}
      api-key: ${KONG_VOICE_AGENT_QWEN_API_KEY:${DASHSCOPE_API_KEY:}}
      url: ${KONG_VOICE_AGENT_ASR_QWEN_URL:wss://dashscope.aliyuncs.com/api-ws/v1/realtime}
      model: ${KONG_VOICE_AGENT_ASR_QWEN_MODEL:qwen3-asr-flash-realtime}
      language: ${KONG_VOICE_AGENT_ASR_QWEN_LANGUAGE:zh}
      input-audio-format: ${KONG_VOICE_AGENT_ASR_QWEN_INPUT_AUDIO_FORMAT:pcm}
      enable-turn-detection: ${KONG_VOICE_AGENT_ASR_QWEN_ENABLE_TURN_DETECTION:false}
      turn-detection-type: ${KONG_VOICE_AGENT_ASR_QWEN_TURN_DETECTION_TYPE:server_vad}
      turn-detection-threshold: ${KONG_VOICE_AGENT_ASR_QWEN_TURN_DETECTION_THRESHOLD:0.0}
      turn-detection-silence-duration-ms: ${KONG_VOICE_AGENT_ASR_QWEN_TURN_DETECTION_SILENCE_DURATION_MS:400}
      timeout-ms: ${KONG_VOICE_AGENT_ASR_QWEN_TIMEOUT_MS:30000}
  tts:
    qwen:
      api-key: ${KONG_VOICE_AGENT_QWEN_API_KEY:${DASHSCOPE_API_KEY:}}
      url: ${KONG_VOICE_AGENT_TTS_QWEN_URL:wss://dashscope.aliyuncs.com/api-ws/v1/realtime}
      model: ${KONG_VOICE_AGENT_TTS_QWEN_MODEL:qwen3-tts-flash-realtime}
      voice: ${KONG_VOICE_AGENT_TTS_QWEN_VOICE:Cherry}
      language-type: ${KONG_VOICE_AGENT_TTS_QWEN_LANGUAGE_TYPE:Chinese}
      mode: ${KONG_VOICE_AGENT_TTS_QWEN_MODE:server_commit}
      response-format: ${KONG_VOICE_AGENT_TTS_QWEN_RESPONSE_FORMAT:PCM_24000HZ_MONO_16BIT}
      format: ${KONG_VOICE_AGENT_TTS_QWEN_FORMAT:pcm}
      sample-rate: ${KONG_VOICE_AGENT_TTS_QWEN_SAMPLE_RATE:24000}
      instructions: ${KONG_VOICE_AGENT_TTS_QWEN_INSTRUCTIONS:}
      optimize-instructions: ${KONG_VOICE_AGENT_TTS_QWEN_OPTIMIZE_INSTRUCTIONS:false}
      timeout-ms: ${KONG_VOICE_AGENT_TTS_QWEN_TIMEOUT_MS:30000}
  vad:
    model-path: ${KONG_VOICE_AGENT_VAD_MODEL_PATH:file:models/silero_vad.onnx}
    speech-threshold: 0.6
    fallback-enabled: true
  eou:
    enabled: ${KONG_VOICE_AGENT_EOU_ENABLED:true}
    provider: livekit-multilingual
    model-path: ${KONG_VOICE_AGENT_EOU_MODEL_PATH:file:models/livekit-turn-detector/model_quantized.onnx}
    tokenizer-path: ${KONG_VOICE_AGENT_EOU_TOKENIZER_PATH:file:models/livekit-turn-detector/tokenizer.json}
    fallback-enabled: true
    default-threshold: 0.5
    min-silence-ms: 500
    max-silence-ms: 1600
    inference-timeout-ms: 300
    language: zh
  rtc:
    enabled: ${KONG_VOICE_AGENT_RTC_ENABLED:false}
    ice-servers:
      - ${KONG_VOICE_AGENT_RTC_ICE_SERVER_1:stun:stun.l.google.com:19302}
    signaling-timeout-ms: ${KONG_VOICE_AGENT_RTC_SIGNALING_TIMEOUT_MS:15000}
```

`kong-voice-agent.auth.fixed-user` 是当前应用侧固定账号配置，默认只用于本地 mock 闭环和前端联调。公开部署时必须通过环境变量覆盖默认密码：

```bash
KONG_VOICE_AGENT_AUTH_FIXED_USER_ACCOUNT_ID=your-account-id
KONG_VOICE_AGENT_AUTH_FIXED_USER_USERNAME=your-username
KONG_VOICE_AGENT_AUTH_FIXED_USER_PASSWORD=your-strong-password
```

登录成功签发的 token 只保存在当前服务进程内存中；应用重启后旧 token 全部失效，当前版本也不提供跨实例共享、过期时间刷新或撤销接口。

`kong-voice-agent.audio` 会绑定到运行时 `AudioFormatSpec`，用于每个新 session 的 PCM 缓冲区、pre-roll 缓冲区和每会话 ASR 适配器创建。

`kong-voice-agent.rtc` 控制首版 WebRTC 音频接入能力：

- `enabled`：是否启用 WebRTC signaling handler 与 RTC 媒体桥接，默认 `false`
- `ice-servers`：浏览器建链时返回给前端的 ICE server 列表，默认包含 `stun:stun.l.google.com:19302`
- `signaling-timeout-ms`：等待 SDP offer / answer 等协商完成的超时时间，默认 `15000`

本地验证 WebRTC 时，至少需要打开：

```bash
KONG_VOICE_AGENT_RTC_ENABLED=true
```

`IdUtils.snowflakeId()` 可生成 64 位趋势递增雪花 ID，`IdUtils.snowflakeIdStr()` 会返回对应的字符串形式；用户 turnId 使用字符串形式下发，调用方只应按相等性判断当前 turn。多实例部署时建议为每个实例显式分配 0 到 1023 之间的节点号：

```bash
KONG_VOICE_AGENT_SNOWFLAKE_NODE_ID=1
```

也可以通过 JVM 系统属性指定：

```bash
java -Dkong.voice-agent.snowflake.node-id=1 -jar kong-voice-agent-app/target/kong-voice-agent-app-0.1.jar
```

未配置节点号时，当前进程会随机选择一个节点号，适合本地单机验证；生产多实例应显式配置，避免实例间节点号碰撞。

`kong-voice-agent.onnx` 会统一影响默认 `kong-voice-extension-vad-silero` 与 `kong-voice-extension-eou-livekit` 的 ONNX Runtime session。默认使用 CPU；需要尝试 CUDA GPU 时，运行前设置：

```bash
KONG_VOICE_AGENT_ONNX_GPU_ENABLED=true
KONG_VOICE_AGENT_ONNX_GPU_DEVICE_ID=0
KONG_VOICE_AGENT_ONNX_FALLBACK_TO_CPU=true
```

GPU 模式需要使用 ONNX Runtime GPU 原生包构建，并准备匹配的 CUDA 运行环境：

```bash
mvn clean package -Donnxruntime.artifactId=onnxruntime_gpu
```

如果 `fallback-to-cpu=true`，CUDA provider 不可用时会回退到 CPU session；如果设置为 `false`，GPU 初始化失败会按 VAD / EOU 自身的 `fallback-enabled` 策略处理。

如果需要指定 VAD 模型路径，可以设置环境变量：

```bash
KONG_VOICE_AGENT_VAD_MODEL_PATH=file:/absolute/path/to/silero_vad.onnx
```

没有模型文件时，项目仍可启动并使用 RMS fallback，适合新手先完成 mock 闭环验证。

EOU 用于在 VAD 发现静音候选后判断“用户这句话是否已经说完”。默认 provider 由 `kong-voice-extension-eou-livekit` 提供，为 LiveKit MultilingualModel 风格的本地 ONNX 实现；模型和 tokenizer 需要放在 `models/livekit-turn-detector/`。如果文件缺失且 `fallback-enabled=true`，系统会回到原静音端点行为。需要指定模型时可以设置：

```bash
KONG_VOICE_AGENT_EOU_MODEL_PATH=file:/absolute/path/to/model_quantized.onnx
KONG_VOICE_AGENT_EOU_TOKENIZER_PATH=file:/absolute/path/to/tokenizer.json
```

## Qwen ASR / Qwen TTS 联调

默认扩展通过 DashScope Java SDK 和 `kong-http` 对接阿里云百炼 Qwen ASR Realtime / Qwen TTS：

- ASR：每个语音 turn 建立一个 Qwen-ASR-Realtime 会话，按 PCM 分片调用 `appendAudio`，在 `audio_end` 或端点提交时等待最终转写，默认模型为 `qwen3-asr-flash-realtime`。
- TTS：按 turnId 累计 LLM 文本到句子边界或最后一个 chunk，再通过 DashScope Java SDK 创建 Qwen TTS Realtime 会话；默认 `server_commit` 模式由服务端判断合成时机，收到 `response.audio.delta` 后立即把 Base64 音频分片转换为 `tts_audio_chunk`。

启动前需要配置百炼 API Key：

```bash
export DASHSCOPE_API_KEY=sk-xxxx
```

Windows PowerShell：

```powershell
$env:DASHSCOPE_API_KEY="sk-xxxx"
```

应用侧 LLM 会先使用 `qwen3.8-flash` 对最近的用户语音转写做隐藏路由。题面完整且清晰的选择题以及尚未念完的题目使用 `qwen3.7-plus`；包含公式、符号、代码转写歧义的完整题目和编程题使用 `qwen3.8-max`。服务端还会对“念不准、公式、符号、代码、平方、根号、上下标、取模”等线索做本地兜底，避免分类模型低估歧义；路由失败时也会回退到 Max，优先保证答案质量。当前两个答题模型均关闭百炼的显式 thinking 模式，因为 AgentScope 1.0.11 会把该字段并入正文流，导致内部草稿进入字幕与 TTS；Max 模型仍用于更复杂的题目。可通过环境变量覆盖各层模型：

```powershell
$env:AI_ROUTER_MODEL="qwen3.8-flash"
$env:AI_CHOICE_MODEL="qwen3.7-plus"
$env:AI_REASONING_MODEL="qwen3.8-max"
```

LLM 的系统提示词位于 `kong-voice-agent-app/src/main/java/io/github/kongweiguang/voice/agent/app/service/AgentService.java` 的 `createAgent()` 方法中，修改 `.sysPrompt(...)` 文本块后需要重新构建并重启后端。

也可以使用项目专用环境变量覆盖：

```bash
export KONG_VOICE_AGENT_QWEN_API_KEY=sk-xxxx
```

外部服务不可用、鉴权失败或返回空音频时会明确失败，不回退到假转写或假音频；TTS 下游失败会通过 WebSocket 下发 `error(code=tts_failed)`，当前连接不会因为 Reactor 回调异常而中断。默认 Qwen TTS 已内置句子级文本积攒，未到句末的非末尾 LLM 片段不会立即合成，避免播放出现过短音频片段导致的不连贯。

常用配置项：

| 配置项 | 默认值 | 环境变量 |
| --- | --- | --- |
| `kong-voice-agent.asr.qwen.enabled` | `true` | `KONG_VOICE_AGENT_ASR_QWEN_ENABLED` |
| `kong-voice-agent.asr.qwen.api-key` | 空 | `KONG_VOICE_AGENT_QWEN_API_KEY` 或 `DASHSCOPE_API_KEY` |
| `kong-voice-agent.asr.qwen.url` | `wss://dashscope.aliyuncs.com/api-ws/v1/realtime` | `KONG_VOICE_AGENT_ASR_QWEN_URL` |
| `kong-voice-agent.asr.qwen.model` | `qwen3-asr-flash-realtime` | `KONG_VOICE_AGENT_ASR_QWEN_MODEL` |
| `kong-voice-agent.asr.qwen.language` | `zh` | `KONG_VOICE_AGENT_ASR_QWEN_LANGUAGE` |
| `kong-voice-agent.asr.qwen.input-audio-format` | `pcm` | `KONG_VOICE_AGENT_ASR_QWEN_INPUT_AUDIO_FORMAT` |
| `kong-voice-agent.asr.qwen.enable-turn-detection` | `false` | `KONG_VOICE_AGENT_ASR_QWEN_ENABLE_TURN_DETECTION` |
| `kong-voice-agent.asr.qwen.turn-detection-type` | `server_vad` | `KONG_VOICE_AGENT_ASR_QWEN_TURN_DETECTION_TYPE` |
| `kong-voice-agent.asr.qwen.turn-detection-threshold` | `0.0` | `KONG_VOICE_AGENT_ASR_QWEN_TURN_DETECTION_THRESHOLD` |
| `kong-voice-agent.asr.qwen.turn-detection-silence-duration-ms` | `400` | `KONG_VOICE_AGENT_ASR_QWEN_TURN_DETECTION_SILENCE_DURATION_MS` |
| `kong-voice-agent.asr.qwen.timeout-ms` | `30000` | `KONG_VOICE_AGENT_ASR_QWEN_TIMEOUT_MS` |
| `kong-voice-agent.tts.qwen.api-key` | 空 | `KONG_VOICE_AGENT_QWEN_API_KEY` 或 `DASHSCOPE_API_KEY` |
| `kong-voice-agent.tts.qwen.url` | `wss://dashscope.aliyuncs.com/api-ws/v1/realtime` | `KONG_VOICE_AGENT_TTS_QWEN_URL` |
| `kong-voice-agent.tts.qwen.model` | `qwen3-tts-flash-realtime` | `KONG_VOICE_AGENT_TTS_QWEN_MODEL` |
| `kong-voice-agent.tts.qwen.voice` | `Cherry` | `KONG_VOICE_AGENT_TTS_QWEN_VOICE` |
| `kong-voice-agent.tts.qwen.language-type` | `Chinese` | `KONG_VOICE_AGENT_TTS_QWEN_LANGUAGE_TYPE` |
| `kong-voice-agent.tts.qwen.mode` | `server_commit` | `KONG_VOICE_AGENT_TTS_QWEN_MODE` |
| `kong-voice-agent.tts.qwen.response-format` | `PCM_24000HZ_MONO_16BIT` | `KONG_VOICE_AGENT_TTS_QWEN_RESPONSE_FORMAT` |
| `kong-voice-agent.tts.qwen.format` | `pcm` | `KONG_VOICE_AGENT_TTS_QWEN_FORMAT` |
| `kong-voice-agent.tts.qwen.sample-rate` | `24000` | `KONG_VOICE_AGENT_TTS_QWEN_SAMPLE_RATE` |
| `kong-voice-agent.tts.qwen.instructions` | 空 | `KONG_VOICE_AGENT_TTS_QWEN_INSTRUCTIONS` |
| `kong-voice-agent.tts.qwen.optimize-instructions` | `false` | `KONG_VOICE_AGENT_TTS_QWEN_OPTIMIZE_INSTRUCTIONS` |
| `kong-voice-agent.tts.qwen.timeout-ms` | `30000` | `KONG_VOICE_AGENT_TTS_QWEN_TIMEOUT_MS` |

## 替换真实服务

当前默认 ASR 由 `kong-voice-extension-asr-qwen` 提供，默认 VAD 由 `kong-voice-extension-vad-silero` 提供，默认 EOU 由 `kong-voice-extension-eou-livekit` 提供，默认 TTS 由 `kong-voice-extension-tts-qwen` 提供，LLM 使用应用侧默认实现。`/ws/agent` 及其内置 `ping` / `interrupt` / `audio_end` / `text` 消息处理继续由 `kong-voice-agent-core` 默认提供。后续接入其他生产服务时，优先通过 Spring Bean 覆盖这些接口：

- `StreamingAsrAdapterFactory`：为每个 session 创建独立的流式 ASR 实例
- `EouDetector`：替换整体 EOU 判断逻辑，可接入自研模型、云端 EOU 服务或规则引擎
- `EouHistoryProvider`：为默认 LiveKit EOU 实现按会话查询最近对话历史；core 不主动记录业务对话内容
- `LlmOrchestrator`：接入真实大模型流式生成
- `TtsOrchestrator`：接入真实 TTS 流式合成
- `VoicePipelineHook`：观察音频、文本、turn commit、LLM、TTS 和打断节点，适合做日志、审计、埋点和业务上下文记录

如果业务模块希望直接复用 OpenAI 兼容的 LLM 实现，可以额外引入 `kong-voice-extension-llm-openai`，并通过 `kong-voice-agent.llm.openai.*` 配置 `api-key`、`base-url`、`chat-completions-path`、`model`、`system-prompt`、`temperature` 和 `timeout-ms`。

如果业务模块希望单独复用阿里百炼 Qwen ASR Realtime，可以引入 `kong-voice-extension-asr-qwen` 并设置：

```xml
<dependency>
    <groupId>io.github.kongweiguang</groupId>
    <artifactId>kong-voice-extension-asr-qwen</artifactId>
</dependency>
```

```bash
KONG_VOICE_AGENT_ASR_QWEN_ENABLED=true
KONG_VOICE_AGENT_QWEN_API_KEY=sk-xxxx
```

Qwen ASR Realtime 扩展会为每个语音 turn 建立一个 DashScope SDK 实时会话，`acceptAudio` 将 PCM 分片 Base64 后调用 `appendAudio`，`commitTurn` 在默认 manual 模式下调用 `commit()` 和 `endSession()` 等待最终稿。DashScope Java SDK 2.22.17 的 `OmniRealtimeConfig` 默认会带上 `server_vad`，因此项目在 `enable-turn-detection=false` 时会显式把 `turn_detection` 下发为 `null`，避免上游过早自动断句。DashScope 在最终稿发出后如果再回一个 `connection.closed(code=1000)`，实现会按正常收尾处理；如果 completed 事件文本为空但此前已有 partial，会用最近 partial 兜底；如果 SDK 随后在清理阶段抛出 `conversation is already closed!`，也会被视为幂等关闭，不会覆盖已经拿到的最终转写，也不会阻断后续 `asr_final`、LLM 和 TTS。项目本地已有 VAD / EOU；如需让百炼服务端 VAD 参与断句，可改为 `true`。

应用默认 LLM 提示将 Agent 定义为实时语音做题助手：选择题会等待题干和选项完整后给出简短结论；编程题默认使用 Python 3，先分析思路并确认用户没有疑问后再输出代码，代码只保留少量关键中文注释，并可按实际长度动态分段续写。提示词同时要求模型结合题面修正语音转写中的公式、符号和代码歧义。完整系统提示位于 `AgentService.createAgent()` 的 `.sysPrompt(...)` 文本块；修改后需重新构建并重启应用。

WebSocket JSON 上行消息也可以通过注册 `WsTextMessageHandler` Bean 扩展新的业务 `type`。内置 `ping`、`interrupt`、`audio_end`、`text` 不允许覆盖，以保证公开协议稳定。

EOU 扩展示例：

```java
@Bean
public EouDetector customEouDetector() {
    return context -> new EouPrediction(true, 1.0, 0.5, "custom_rule", false);
}

@Bean
public EouHistoryProvider eouHistoryProvider(ChatHistoryService chatHistoryService) {
    return (sessionId, maxTurns) -> chatHistoryService.recentTurns(sessionId, maxTurns);
}
```

## 测试

执行全部测试：

```bash
mvn test
```

默认测试不加载真实大模型文件。需要验证 LiveKit EOU ONNX 模型资产时，先放好 `models/livekit-turn-detector/model_quantized.onnx` 和 `models/livekit-turn-detector/tokenizer.json`，再显式开启扩展模块中的模型集成测试：

```bash
mvn -pl "kong-voice-extension/kong-voice-extension-eou-livekit" "-Dkong.voice-agent.model-tests=true" "-Dtest=MultilingualEouDetectorTest" test
```

需要严格确认 EOU 真实模型使用 CUDA 而不是 CPU 回退时，先安装 CUDA 12.x Toolkit 和 cuDNN 9.x，并确保 `cudart64_12.dll`、`cublas64_12.dll`、`cublasLt64_12.dll`、`cudnn64_9.dll` 能从 `PATH` 找到，然后执行：

```powershell
mvn -pl "kong-voice-extension/kong-voice-extension-eou-livekit" "-Dkong.voice-agent.model-tests=true" "-Dkong.voice-agent.cuda-tests=true" "-Dtest=MultilingualEouDetectorTest" test
```

如果 CUDA 或 cuDNN 的 `bin` 目录尚未加入当前 PowerShell 进程的 `PATH`，可以先临时补齐再执行同一条 Maven 命令：

```powershell
$env:PATH="C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9\bin;C:\path\to\cudnn\bin;$env:PATH"
mvn -pl "kong-voice-extension/kong-voice-extension-eou-livekit" "-Dkong.voice-agent.model-tests=true" "-Dkong.voice-agent.cuda-tests=true" "-Dtest=MultilingualEouDetectorTest" test
```

这条命令会使用当前工程默认的 `onnxruntime_gpu` 依赖，并启用 `fallbackToCpu=false` 的严格 CUDA 测试；只要 CUDA provider 加载失败，测试就会失败，不会悄悄走 CPU。

当前测试重点覆盖：

- PCM 工具和音频缓冲
- Session 生命周期
- TurnManager 状态边界
- EOU 自动装配、prompt 构造和 endpointing 边界
- turn committed 后才进入 LLM
- interruption 后旧 turn 结果被丢弃
- WebSocket 消息解析和处理器注册边界

后续新增协议、状态机、异步 turnId 隔离、打断流程或公开扩展点时，需要同步补充测试。

## 常见问题

### 启动时提示找不到 `models/silero_vad.onnx`

这是可接受的。当前配置允许模型缺失时回退到 RMS fallback；ASR 和 TTS 默认依赖百炼服务，需要先配置 `DASHSCOPE_API_KEY` 或 `KONG_VOICE_AGENT_QWEN_API_KEY`。

### 收到 `Qwen ASR API Key 未配置`

先确认运行应用的同一个终端或进程环境里已经设置 `DASHSCOPE_API_KEY`，也可以设置 `KONG_VOICE_AGENT_QWEN_API_KEY`。如果使用 IDE 启动，需要把环境变量加到 Run Configuration 中。

### 收到 `Qwen TTS API Key 未配置`

先确认运行应用的同一个终端或进程环境里已经设置 `DASHSCOPE_API_KEY`，也可以设置 `KONG_VOICE_AGENT_QWEN_API_KEY`。如果使用 IDE 启动，需要把环境变量加到 Run Configuration 中。

### 收到 `Qwen TTS 返回了空音频`

先确认 API Key 有效、模型名称和音色名称可用，并检查网络能访问 `https://dashscope.aliyuncs.com`。如果接口返回了空字节流，后端会下发 `error(code=tts_failed)`，前端应展示错误并停止当前 turn 的播放队列。

### 连接不上 WebSocket

请确认后端已经启动，并检查端口是否为 `9877`：

```text
ws://localhost:9877/ws/agent?token=<login-token>
```

如果 WebSocket 握手返回 401，请先调用 `POST /api/auth/login` 获取 token，并确认 URL 中的 `token` query 参数没有丢失或被截断。服务重启后内存 token 会失效，需要重新登录。如果修改过 `server.port`，React UI 的登录地址和 WebSocket 地址都需要同步修改。

### React UI 连接到了错误的后端地址

`ui/` 默认使用 `VITE_AGENT_HTTP_BASE=http://localhost:9877` 和 `VITE_AGENT_WS_BASE=ws://localhost:9877`。如果后端端口、域名或代理路径发生变化，请在 `ui/.env.local` 中覆盖这两个变量，然后重新执行 `pnpm dev`。

### 麦克风没有事件或没有 ASR final

先用文本输入验证后端链路，再检查浏览器是否授予麦克风权限。音频必须转换为服务端 `kong-voice-agent.audio` 配置的格式；默认是 16kHz / mono / PCM16 little-endian。如果采样率或格式不对，服务端无法按预期处理。

### 为什么 partial transcript 不会触发 LLM

当前版本明确不支持 preemptive。只有 turn committed 后才会启动 LLM 和 TTS，这样可以保证协议边界稳定，并避免用户还没说完时提前生成错误回复。

### 启动时报 `Could not find class [org.springframework.boot.thread.Threading]`

这是 Spring Boot 依赖版本不一致的典型表现。本项目要求 `spring-boot`、`spring-boot-autoconfigure` 和 Spring Framework 版本由根工程 `spring-boot.version` 统一管理；如果新增第三方 BOM，需要确认它没有把 Spring Boot 自动配置包提升到另一个主版本。可以执行下面命令检查：

```bash
mvn -pl kong-voice-agent-app dependency:tree -Dincludes=org.springframework.boot
```

正常情况下，`spring-boot` 和 `spring-boot-autoconfigure` 应该同为 `3.4.8`。

## 文档索引

- [docs/architecture.md](docs/architecture.md)：模块分层、数据流、文本/音频路径和打断流程图
- [docs/features.md](docs/features.md)：功能文档入口
- [docs/protocol.md](docs/protocol.md)：WebSocket 控制面、WebRTC signaling 与 JSON 示例
- [docs/frontend-integration.md](docs/frontend-integration.md)：前端接入、`WS PCM / WebRTC` 联调说明
- [docs/system-state.md](docs/system-state.md)：已完成并稳定可用的功能
- [docs/in-progress.md](docs/in-progress.md)：当前正在开发中的功能列表和计划入口
- [docs/plan/README.md](docs/plan/README.md)：正在开发功能的步骤计划目录说明
- [docs/roadmap.md](docs/roadmap.md)：后续计划

建议新手阅读顺序：

1. 先按本 README 跑通文本闭环
2. 再启动 `ui/` 的 React 对话界面验证登录、连接和文本对话
3. 然后阅读 `docs/architecture.md` 理解整体数据流
4. 再阅读 `docs/protocol.md` 理解消息字段
5. 最后阅读 `docs/system-state.md`、`docs/in-progress.md`、`docs/plan/README.md` 和 `docs/roadmap.md` 理解系统边界、当前推进方式与后续方向
