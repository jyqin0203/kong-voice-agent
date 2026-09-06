# System State

最后更新：2026-05-03

这份文档只维护项目当前已经完成并稳定沉淀下来的功能能力，便于跨会话快速了解系统现在已经具备什么。

## 已完成功能

- 工程骨架：已完成 Java 21 + Spring Boot 3 + Maven 多模块结构，包含 `kong-voice-agent-core`、`kong-voice-extension`、`kong-voice-agent-app` 和 `ui/` React 前端工程。
- 登录鉴权：已提供 `POST /api/auth/login` 固定账号登录，WebSocket 握手通过 `token` 做进程内鉴权。
- WebSocket 接入：已支持 `/ws/agent` 控制面连接、`ping`、`interrupt`、`audio_end`、`text` 和二进制 PCM 音频上行。
- WebRTC 接入：已支持 `rtc_start`、`rtc_offer`、`rtc_ice_candidate`、`rtc_close`，并支持控制面重连复用 `sessionId`、RTC 音频输入和 RTC 音频播放。
- Session 与 turn 隔离：已支持独立 `sessionId`、雪花 ID 字符串 `turnId`、旧 turn 失效和异步结果隔离。
- 音频基础设施：已支持 `AudioFormatSpec` 配置绑定、PCM 工具、ring buffer、pre-roll 和音频标准化入口。
- VAD：已接入 Silero VAD 扩展，模型缺失时支持 RMS fallback。
- ASR：已接入 Qwen ASR Realtime 扩展和可选 OpenAI ASR 扩展，当前在 turn commit 或 `audio_end` 后输出最终转写，并可接收真实 partial。
- EOU 与 TurnManager：已支持 VAD + EOU + endpointing 协同推进 turn committed。
- LLM 编排：已支持 turn committed 后启动 LLM，当前应用默认使用 app 模块实现，也支持扩展模块方式接入 OpenAI LLM。
- TTS 编排：已接入 Qwen TTS Realtime 扩展和可选 OpenAI TTS 扩展，支持文本分段累计、实时音频回传和错误下行。
- 时延观测：已支持按 turn 下发 `turn_metrics`，统计 ASR / LLM / TTS 的响应时间、总耗时，以及 turn committed 到 LLM 首字、TTS 首包的时延。
- HTTP / Realtime / SSE / JSON 基础能力：OpenAI ASR、Qwen ASR、应用侧 AgentScope LLM、OpenAI LLM 扩展、OpenAI TTS、Qwen TTS 和项目协议 JSON 工具已统一复用 `kong-http` 与 DashScope Java SDK 提供的请求、实时 WebSocket 和 JSON 能力。
- 打断流程：已支持客户端主动 `interrupt` 和用户说话打断播报。
- Hook 扩展：已提供 `VoicePipelineHook`，可观察音频、文本、turn commit、LLM、TTS 和 interruption 节点。
- React 联调界面：已提供 `ui/` 产品化聊天界面，支持固定账号登录、`WS PCM / WebRTC` 切换、多会话、本地历史、TTS 播放，以及一次开启后自动断句、等待回答、播完继续监听的电话式连续通话。
- 文档体系：已建立 README、架构、协议、前端联调、功能索引、进行中清单、路线图和已完成能力文档分工。
- 基础测试：已覆盖 PCM 工具、Session、TurnManager、文本链路、协议解析、WebRTC 关键回归和部分 OpenAI 适配器边界。

## 使用方式

- 想看系统现在已经能做什么，先读本文件。
- 想看当前正在开发什么，读 `docs/in-progress.md`。
- 想看后续准备推进什么，读 `docs/roadmap.md`。
- 想看架构、协议和联调细节，分别读 `docs/architecture.md`、`docs/protocol.md`、`docs/frontend-integration.md`。
