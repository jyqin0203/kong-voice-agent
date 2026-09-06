import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  History,
  Loader2,
  LogIn,
  LogOut,
  Menu,
  MessageSquarePlus,
  Mic,
  MicOff,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Sun,
  UserRound,
  Volume2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  AgentEventEnvelope,
  buildAgentWsUrl,
  loginAgent,
  LoginResponse,
  sendWsJson,
} from "@/api/agentClient";
import {
  closeRtcSession,
  createRtcSession,
  submitRtcCandidate,
  submitRtcOffer,
} from "@/api/rtcClient";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** 对话消息角色。 */
type MessageRole = "user" | "assistant" | "system";

/** 对话消息模型，用于右侧消息流渲染。 */
interface ChatMessage {
  /** 前端生成的稳定消息 id。 */
  id: string;
  /** 消息归属角色。 */
  role: MessageRole;
  /** 消息文本内容。 */
  content: string;
  /** 后端 turn id，系统消息允许为空。 */
  turnId?: string | null;
  /** 消息是否仍在流式生成。 */
  streaming?: boolean;
  /** TTS 音频是否正在播放这条助手消息。 */
  speaking?: boolean;
  /** 消息创建时间。 */
  createdAt: Date;
}

/** 历史会话条目，用于左侧列表展示。 */
interface ConversationSummary {
  /** 历史项唯一标识。 */
  id: string;
  /** 历史项标题。 */
  title: string;
  /** 最近一条消息摘要。 */
  preview: string;
  /** 最近更新时间文案。 */
  updatedAt: string;
  /** 是否为当前选中会话。 */
  active?: boolean;
}

/** 浏览器本地持久化的前端会话记录。 */
interface ConversationRecord extends ConversationSummary {
  /** 后端返回的 sessionId，用于回看时确认这条记录对应的历史连接。 */
  sessionId?: string | null;
  /** 当前会话最近一次活跃 turnId。 */
  currentTurnId?: string | null;
  /** 当前会话最近一次完成轮次的指标快照。 */
  latestMetrics?: TurnMetricsView | null;
  /** 该会话的本地消息快照。 */
  messages: ChatMessage[];
  /** 当前会话使用的媒体传输模式。 */
  transportKind: TransportKind;
  /** 会话创建时间戳。 */
  createdAtMs: number;
  /** 会话最近更新时间戳。 */
  updatedAtMs: number;
}

/** WebSocket 连接状态。 */
type ConnectionState = "disconnected" | "connecting" | "connected";

/** 媒体传输模式。 */
type TransportKind = "ws-pcm" | "webrtc";

/** TTS 播放队列项，按同一 turn 内的 seq 顺序播放。 */
interface TtsPlaybackItem {
  /** 音频所属 turn id。 */
  turnId: string;
  /** 同一 turn 内的 TTS 序号。 */
  seq: number;
  /** 后端返回的 base64 音频字节。 */
  audioBase64: string;
}

/** 当前会话展示用的 turn 指标快照。 */
interface TurnMetricsView {
  /** 指标所属 turn。 */
  turnId: string | null;
  /** 当前指标阶段。 */
  stage: string;
  /** 当前 turn 来源。 */
  source: string;
  /** ASR 首次响应时间。 */
  asrResponseLatencyMs: number | null;
  /** ASR 总耗时。 */
  asrDurationMs: number | null;
  /** LLM 首字时间。 */
  llmResponseLatencyMs: number | null;
  /** LLM 总耗时。 */
  llmDurationMs: number | null;
  /** TTS 首包时间。 */
  ttsResponseLatencyMs: number | null;
  /** TTS 总耗时。 */
  ttsDurationMs: number | null;
  /** 说完话到 LLM 首字时间。 */
  speechEndToLlmFirstTokenMs: number | null;
  /** 说完话到 TTS 首包时间。 */
  speechEndToTtsFirstChunkMs: number | null;
  /** 服务端事件时间。 */
  timestamp: string | null;
}

/** 当前前端会话对应的 RTC 运行态。 */
interface RtcConversationRuntime {
  /** 后端 RTC sessionId。 */
  sessionId: string;
  /** 浏览器 PeerConnection。 */
  peerConnection: RTCPeerConnection;
  /** 本地麦克风流。 */
  localStream: MediaStream;
  /** 当前远端播放节点。 */
  remoteAudio: HTMLAudioElement;
}

/** 登录表单初始值。 */
const DEFAULT_LOGIN_FORM = {
  username: "demo",
  password: "demo123456",
};

/** 首屏建议问题，帮助用户快速开始本地联调。 */
const STARTER_PROMPTS = [
  "你好，介绍一下你自己",
  "现在的连接状态正常吗？",
  "请用一句话说明 voice agent 的流程",
];

/** React UI 上传给后端的默认麦克风采样率，需要与服务端默认音频配置一致。 */
const MICROPHONE_TARGET_SAMPLE_RATE = 16000;

/** 本地会话列表持久化 key。 */
const CONVERSATION_STORAGE_KEY = "kong-voice-agent.conversations.v1";

/** 当前选中会话持久化 key。 */
const ACTIVE_CONVERSATION_STORAGE_KEY = "kong-voice-agent.active-conversation.v1";

/** 主对话工作台，负责登录、连接、发送文本和渲染产品化 AI 对话界面。 */
export function ChatShell() {
  const initialConversations = useMemo(() => loadStoredConversations(), []);
  const initialActiveConversation = useMemo(
    () => resolveInitialActiveConversation(initialConversations),
    [initialConversations],
  );
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginForm, setLoginForm] = useState(DEFAULT_LOGIN_FORM);
  const [login, setLogin] = useState<LoginResponse | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [conversations, setConversations] = useState<ConversationRecord[]>(initialConversations);
  const [activeConversationId, setActiveConversationId] = useState(initialActiveConversation.id);
  const [sessionId, setSessionId] = useState<string | null>(initialActiveConversation.sessionId ?? null);
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(initialActiveConversation.currentTurnId ?? null);
  const [playbackStatus, setPlaybackStatus] = useState("等待 TTS");
  const [turnActive, setTurnActive] = useState(false);
  const [recording, setRecording] = useState(false);
  const [audioInputStatus, setAudioInputStatus] = useState("麦克风未开启");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(initialActiveConversation.messages);
  const [latestMetrics, setLatestMetrics] = useState<TurnMetricsView | null>(initialActiveConversation.latestMetrics ?? null);
  const [transportKind, setTransportKind] = useState<TransportKind>(initialActiveConversation.transportKind);
  const [connectionStates, setConnectionStates] = useState<Record<string, ConnectionState>>({});
  const [connectionErrors, setConnectionErrors] = useState<Record<string, string | null>>({});
  const conversationsRef = useRef(conversations);
  const socketsRef = useRef(new Map<string, WebSocket>());
  const rtcConnectionsRef = useRef(new Map<string, RtcConversationRuntime>());
  const rtcReconnectTimersRef = useRef(new Map<string, number>());
  const rtcReconnectAttemptsRef = useRef(new Map<string, number>());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const currentAudioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const microphoneContextRef = useRef<AudioContext | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const microphoneSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const microphoneProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const microphoneMuteRef = useRef<GainNode | null>(null);
  const recordingRef = useRef(false);
  /** 连续通话开启后保持麦克风资源存活，直到用户再次点击按钮。 */
  const continuousCallActiveRef = useRef(false);
  /** 控制 PCM 是否上传；Agent 思考和播报期间暂停，避免扬声器回声形成错误插话。 */
  const microphoneUploadEnabledRef = useRef(false);
  /** 标记当前 Agent 文本是否结束，避免在长回答仍生成时过早恢复监听。 */
  const assistantTextFinishedRef = useRef(false);
  /** 延迟恢复监听的定时器，用于吸收相邻 TTS 分片之间的短暂空隙。 */
  const resumeListeningTimerRef = useRef<number | null>(null);
  const playbackQueueRef = useRef<TtsPlaybackItem[]>([]);
  const playingAudioRef = useRef(false);
  const currentTurnIdRef = useRef<string | null>(null);
  const activeConversationIdRef = useRef(activeConversationId);
  const invalidTurnIdsRef = useRef(new Set<string>());

  /** 当前是否已经建立可发送消息的 WebSocket 连接。 */
  const connectionState = connectionStates[activeConversationId] ?? "disconnected";
  /** 当前会话最近一次连接失败信息。 */
  const connectionError = connectionErrors[activeConversationId] ?? null;
  /** 当前会话是否已经建立可发送消息的 WebSocket 连接。 */
  const connected = connectionState === "connected";

  /** 左侧会话列表，全部来自浏览器 localStorage 和当前运行态。 */
  const history = useMemo(
    () =>
      conversations
        .slice()
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
        .map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          preview: conversation.preview,
          updatedAt: formatConversationTime(conversation.updatedAtMs),
          active: conversation.id === activeConversationId,
        })),
    [activeConversationId, conversations],
  );

  /** 连接状态对应的状态栏文案。 */
  const connectionLabel = useMemo(() => {
    if (connectionState === "connected") {
      return "已连接";
    }
    if (connectionState === "connecting") {
      return "连接中";
    }
    return "未连接";
  }, [connectionState]);

  /** 当前是否还停留在产品化欢迎空状态。 */
  const emptyConversation = messages.length === 0;

  /** 停止麦克风采集，必要时通知后端提交当前音频 turn。 */
  const stopMicrophone = useCallback((sendAudioEnd: boolean) => {
    const wasUploading = microphoneUploadEnabledRef.current;
    recordingRef.current = false;
    continuousCallActiveRef.current = false;
    microphoneUploadEnabledRef.current = false;
    assistantTextFinishedRef.current = false;
    if (resumeListeningTimerRef.current !== null) {
      window.clearTimeout(resumeListeningTimerRef.current);
      resumeListeningTimerRef.current = null;
    }
    setRecording(false);

    if (microphoneProcessorRef.current) {
      microphoneProcessorRef.current.onaudioprocess = null;
      microphoneProcessorRef.current.disconnect();
    }
    microphoneMuteRef.current?.disconnect();
    microphoneSourceRef.current?.disconnect();
    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneContextRef.current?.close().catch(() => {
      // 浏览器可能已经关闭音频上下文，清理阶段忽略即可。
    });

    microphoneProcessorRef.current = null;
    microphoneMuteRef.current = null;
    microphoneSourceRef.current = null;
    microphoneStreamRef.current = null;
    microphoneContextRef.current = null;
    setAudioInputStatus("麦克风未开启");

    const socket = activeSocket();
    if (sendAudioEnd) {
      if (wasUploading && socket?.readyState === WebSocket.OPEN) {
        sendWsJson(socket, "audio_end", {});
        setTurnActive(true);
      }
      setMessages((current) => [...current, systemMessage("连续通话已结束。")]);
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    currentTurnIdRef.current = currentTurnId;
  }, [currentTurnId]);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    persistConversations(conversations);
  }, [conversations]);

  useEffect(() => {
    persistActiveConversationId(activeConversationId);
  }, [activeConversationId]);

  useEffect(() => {
    const syncTimer = window.setTimeout(() => {
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === activeConversationId
            ? {
                ...conversation,
                sessionId,
                currentTurnId,
                latestMetrics,
                messages: sanitizeMessagesForStorage(messages),
                transportKind,
                preview: buildConversationPreview(messages, conversation.preview),
                updatedAtMs: Date.now(),
              }
            : conversation,
        ),
      );
    }, 0);
    return () => window.clearTimeout(syncTimer);
  }, [activeConversationId, currentTurnId, latestMetrics, messages, sessionId, transportKind]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    return () => {
      stopMicrophone(false);
      closeAllRtcConnections();
      closeAllSockets();
      playbackQueueRef.current = [];
      if (currentAudioSourceRef.current) {
        try {
          currentAudioSourceRef.current.stop();
        } catch {
          // 页面卸载时音频节点可能已经结束，忽略即可。
        }
      }
      currentAudioSourceRef.current = null;
      playingAudioRef.current = false;
    };
  }, [stopMicrophone]);

  /** 切换浅色和深色主题。 */
  function toggleTheme() {
    setTheme((current) => (current === "light" ? "dark" : "light"));
  }

  /** 更新登录表单字段。 */
  function updateLoginField(field: keyof typeof DEFAULT_LOGIN_FORM, value: string) {
    setLoginForm((current) => ({ ...current, [field]: value }));
  }

  /** 提交登录表单并保存后端返回的 token。 */
  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginLoading(true);
    setLoginError(null);

    try {
      const result = await loginAgent(loginForm);
      setLogin(result);
      setLoginOpen(false);
      setMessages((current) => [
        ...current,
        systemMessage(`已登录为 ${result.user.username}，可以连接后端 WebSocket。`),
      ]);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "登录失败");
    } finally {
      setLoginLoading(false);
    }
  }

  /** 取得当前选中会话的 WebSocket 连接。 */
  function activeSocket() {
    return socketsRef.current.get(activeConversationIdRef.current) ?? null;
  }

  /** 设置指定会话的 WebSocket 状态，状态按会话隔离，切换会话时不会影响其他连接。 */
  function setConversationConnectionState(sessionId: string, state: ConnectionState) {
    setConnectionStates((current) => ({ ...current, [sessionId]: state }));
  }

  /** 设置指定会话的连接错误。 */
  function setConversationConnectionError(sessionId: string, error: string | null) {
    setConnectionErrors((current) => ({ ...current, [sessionId]: error }));
  }

  /** 关闭指定会话的连接，可用于主动断开、退出登录和页面卸载。 */
  function closeConversationSocket(sessionId: string) {
    const socket = socketsRef.current.get(sessionId);
    if (socket) {
      socketsRef.current.delete(sessionId);
      socket.close();
    }
    setConversationConnectionState(sessionId, "disconnected");
  }

  /** 关闭指定会话的 RTC 连接，并通知后端释放 PeerConnection。 */
  function closeConversationRtc(sessionId: string, options?: { resetReconnectAttempts?: boolean }) {
    clearRtcReconnect(sessionId, options?.resetReconnectAttempts ?? true);
    const runtime = rtcConnectionsRef.current.get(sessionId);
    if (!runtime) {
      return;
    }
    rtcConnectionsRef.current.delete(sessionId);
    runtime.peerConnection.close();
    runtime.localStream.getTracks().forEach((track) => track.stop());
    runtime.remoteAudio.srcObject = null;
    const socket = socketsRef.current.get(sessionId);
    if (socket?.readyState === WebSocket.OPEN) {
      closeRtcSession(socket, runtime.sessionId);
    }
  }

  /** 关闭当前页面持有的所有 WebSocket 连接。 */
  function closeAllSockets() {
    socketsRef.current.forEach((socket) => socket.close());
    socketsRef.current.clear();
    setConnectionStates({});
  }

  /** 关闭当前页面持有的所有 RTC 连接。 */
  function closeAllRtcConnections() {
    Array.from(rtcConnectionsRef.current.keys()).forEach((conversationId) => closeConversationRtc(conversationId));
    rtcReconnectTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    rtcReconnectTimersRef.current.clear();
    rtcReconnectAttemptsRef.current.clear();
  }

  /** 注销当前用户并关闭已建立的所有 WebSocket 连接。 */
  function handleLogout() {
    closeAllRtcConnections();
    closeAllSockets();
    setLogin(null);
    setSessionId(null);
    setCurrentTurnId(null);
    setTurnActive(false);
    stopMicrophone(false);
    stopPlayback("已退出登录。");
    setMessages((current) => [...current, systemMessage("已退出登录。")]);
  }

  /** 重置当前显示会话的运行态，避免旧 turn 和音频继续污染新视图。 */
  function resetConversationRuntime() {
    setSessionId(null);
    setCurrentTurnId(null);
    currentTurnIdRef.current = null;
    invalidTurnIdsRef.current.clear();
    setLatestMetrics(null);
    setTurnActive(false);
    if (transportKind === "ws-pcm") {
      stopMicrophone(false);
    } else {
      setRecording(false);
      recordingRef.current = false;
      setAudioInputStatus("WebRTC 麦克风未连接");
    }
    stopPlayback("等待 TTS");
  }

  /** 返回指定前端会话最近一次绑定的后端 sessionId，重连时优先复用。 */
  function resolveConversationSessionId(conversationId: string) {
    if (conversationId === activeConversationIdRef.current && sessionId) {
      return sessionId;
    }
    return conversationsRef.current.find((conversation) => conversation.id === conversationId)?.sessionId ?? null;
  }

  /** 清理指定会话的 RTC 重连定时器；成功恢复后会顺带重置重试次数。 */
  function clearRtcReconnect(conversationId: string, resetAttempts: boolean) {
    const timerId = rtcReconnectTimersRef.current.get(conversationId);
    if (timerId) {
      window.clearTimeout(timerId);
      rtcReconnectTimersRef.current.delete(conversationId);
    }
    if (resetAttempts) {
      rtcReconnectAttemptsRef.current.delete(conversationId);
    }
  }

  /** 当前会话的 RTC 媒体面断开后，按退避策略自动尝试恢复。 */
  function scheduleRtcReconnect(conversationId: string, reason: string) {
    const nextTransportKind =
      conversationId === activeConversationIdRef.current
        ? transportKind
        : (conversationsRef.current.find((conversation) => conversation.id === conversationId)?.transportKind ?? "ws-pcm");
    if (nextTransportKind !== "webrtc" || !login?.token || rtcReconnectTimersRef.current.has(conversationId)) {
      return;
    }
    const attempt = rtcReconnectAttemptsRef.current.get(conversationId) ?? 0;
    if (attempt >= 3) {
      setConversationConnectionError(conversationId, `${reason}，已达到自动重连上限，请手动重新连接。`);
      if (conversationId === activeConversationIdRef.current) {
        setAudioInputStatus("WebRTC 自动重连已停止");
      }
      return;
    }
    const delayMs = Math.min(1_500 * 2 ** attempt, 10_000);
    setConversationConnectionError(conversationId, `${reason}，${Math.round(delayMs / 1000)} 秒后自动重连。`);
    if (conversationId === activeConversationIdRef.current) {
      setAudioInputStatus("WebRTC 媒体断开，正在准备重连");
      setPlaybackStatus("等待 RTC 重连");
    }
    const timerId = window.setTimeout(() => {
      rtcReconnectTimersRef.current.delete(conversationId);
      rtcReconnectAttemptsRef.current.set(conversationId, attempt + 1);
      connectRtcConversation(conversationId).catch(() => {
        // connectRtcConversation 已负责写入本轮失败信息，下一次重试继续由状态回调触发。
      });
    }, delayMs);
    rtcReconnectTimersRef.current.set(conversationId, timerId);
  }

  /** 使用指定 token 为某个前端会话打开 Agent WebSocket。 */
  function openAgentSocket(token: string, conversationId = activeConversationIdRef.current) {
    const preferredSessionId = resolveConversationSessionId(conversationId);
    closeConversationSocket(conversationId);
    if (conversationId === activeConversationIdRef.current) {
      resetConversationRuntime();
    }
    setConversationConnectionState(conversationId, "connecting");
    setConversationConnectionError(conversationId, null);

    const socket = new WebSocket(buildAgentWsUrl(token, preferredSessionId));
    socketsRef.current.set(conversationId, socket);

    socket.addEventListener("open", () => {
      if (socketsRef.current.get(conversationId) !== socket) {
        return;
      }
      setConversationConnectionState(conversationId, "connected");
      sendWsJson(socket, "ping", { ts: Date.now() });
      if (conversationId === activeConversationIdRef.current) {
        setPlaybackStatus("等待 TTS");
      }
      appendConversationMessage(conversationId, systemMessage("WebSocket 已连接。"));
    });

    socket.addEventListener("message", (event) => {
      if (socketsRef.current.get(conversationId) !== socket) {
        return;
      }
      if (typeof event.data !== "string") {
        return;
      }
      try {
        handleAgentEvent(conversationId, JSON.parse(event.data) as AgentEventEnvelope);
      } catch {
        appendConversationMessage(conversationId, systemMessage("收到无法解析的服务端消息。"));
      }
    });

    socket.addEventListener("close", () => {
      if (socketsRef.current.get(conversationId) !== socket) {
        return;
      }
      socketsRef.current.delete(conversationId);
      closeConversationRtc(conversationId, { resetReconnectAttempts: false });
      setConversationConnectionState(conversationId, "disconnected");
      if (conversationId === activeConversationIdRef.current) {
        setSessionId(null);
        setCurrentTurnId(null);
        setTurnActive(false);
        if (transportKind === "ws-pcm") {
          stopMicrophone(false);
        } else {
          setRecording(false);
          recordingRef.current = false;
          setAudioInputStatus("WebRTC 麦克风未连接");
        }
        stopPlayback("连接已断开。");
      }
    });

    socket.addEventListener("error", () => {
      if (socketsRef.current.get(conversationId) !== socket) {
        return;
      }
      setConversationConnectionError(conversationId, "WebSocket 连接失败，请确认后端已启动且 token 有效。");
      setConversationConnectionState(conversationId, "disconnected");
    });
    return socket;
  }

  /** 等待 WebSocket 真正完成握手，便于后续继续发送 RTC signaling。 */
  function waitForSocketOpen(socket: WebSocket) {
    if (socket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("等待 WebSocket 建连超时。"));
      }, 10_000);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onFailed = () => {
        cleanup();
        reject(new Error("WebSocket 建连失败。"));
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("close", onFailed);
        socket.removeEventListener("error", onFailed);
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("close", onFailed);
      socket.addEventListener("error", onFailed);
    });
  }

  /** 为当前会话建立后端 Agent WebSocket 连接。 */
  async function connectRtcConversation(conversationId: string) {
    if (!login?.token || connectionStates[conversationId] === "connecting") {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setConversationConnectionError(conversationId, "当前浏览器不支持 WebRTC 麦克风采集。");
      return;
    }
    closeConversationRtc(conversationId, { resetReconnectAttempts: false });

    try {
      const socket = openAgentSocket(login.token, conversationId);
      await waitForSocketOpen(socket);
      const rtcSession = await createRtcSession(socket);
      updateConversationSessionTitle(conversationId, rtcSession.sessionId);
      updateConversationTurnId(conversationId, "");

      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const peerConnection = new RTCPeerConnection({ iceServers: rtcSession.iceServers });
      const remoteAudio = new Audio();
      remoteAudio.autoplay = true;

      peerConnection.ontrack = (event) => {
        const [stream] = event.streams;
        remoteAudio.srcObject = stream ?? new MediaStream([event.track]);
        remoteAudio.play().catch(() => {
          // 浏览器可能要求用户手势恢复播放，保留当前流并等待后续用户操作即可。
        });
        if (conversationId === activeConversationIdRef.current) {
          setPlaybackStatus("WebRTC 远端音轨已连接");
        }
      };
      peerConnection.onicecandidate = (event) => {
        if (!event.candidate) {
          return;
        }
        submitRtcCandidate(socket, rtcSession.sessionId, {
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          candidate: event.candidate.candidate,
        });
      };
      peerConnection.oniceconnectionstatechange = () => {
        const state = peerConnection.iceConnectionState;
        if (state === "connected" || state === "completed") {
          clearRtcReconnect(conversationId, true);
          setConversationConnectionError(conversationId, null);
          if (conversationId === activeConversationIdRef.current) {
            setAudioInputStatus("WebRTC 麦克风已连接");
          }
          return;
        }
        if (state === "disconnected") {
          scheduleRtcReconnect(conversationId, "RTC 媒体暂时断开");
          return;
        }
        if (state === "failed") {
          scheduleRtcReconnect(conversationId, "RTC ICE 建链失败");
        }
      };
      peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        if (state === "connected") {
          clearRtcReconnect(conversationId, true);
          setConversationConnectionError(conversationId, null);
          return;
        }
        if (state === "disconnected") {
          scheduleRtcReconnect(conversationId, "PeerConnection 已断开");
          return;
        }
        if (state === "failed") {
          scheduleRtcReconnect(conversationId, "PeerConnection 已失败");
        }
      };
      localStream.getAudioTracks().forEach((track) => peerConnection.addTrack(track, localStream));
      rtcConnectionsRef.current.set(conversationId, {
        sessionId: rtcSession.sessionId,
        peerConnection,
        localStream,
        remoteAudio,
      });

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      const answer = await submitRtcOffer(socket, rtcSession.sessionId, {
        type: offer.type.toUpperCase(),
        sdp: offer.sdp ?? "",
      });
      await peerConnection.setRemoteDescription({
        type: answer.type.toLowerCase() as RTCSdpType,
        sdp: answer.sdp,
      });

      if (conversationId === activeConversationIdRef.current) {
        setSessionId(rtcSession.sessionId);
        setRecording(true);
        recordingRef.current = true;
        setAudioInputStatus("WebRTC 麦克风已连接");
        setPlaybackStatus("等待 RTC 远端音轨");
      }
      clearRtcReconnect(conversationId, true);
      setConversationConnectionError(conversationId, null);
    } catch (error) {
      closeConversationRtc(conversationId, { resetReconnectAttempts: false });
      closeConversationSocket(conversationId);
      setConversationConnectionError(
        conversationId,
        error instanceof Error ? error.message : "WebRTC 连接失败，请确认后端已启用 RTC。",
      );
      scheduleRtcReconnect(conversationId, "WebRTC 连接失败");
    }
  }

  /** 为当前会话建立后端 Agent 连接。 */
  function connectSocket() {
    if (!login?.token || connectionState === "connecting") {
      return;
    }
    if (transportKind === "webrtc") {
      connectRtcConversation(activeConversationId).catch(() => {
        // connectRtcConversation 已负责写入错误信息。
      });
      return;
    }

    openAgentSocket(login.token, activeConversationId);
  }

  /** 主动断开当前会话的 WebSocket 连接。 */
  function disconnectSocket() {
    closeConversationRtc(activeConversationId);
    closeConversationSocket(activeConversationId);
    setSessionId(null);
    setCurrentTurnId(null);
    setTurnActive(false);
    stopMicrophone(false);
    stopPlayback("连接已断开。");
    setMessages((current) => [...current, systemMessage("WebSocket 已断开。")]);
  }

  /** 新建会话时只为新会话打开连接，已有会话的 WebSocket 保持在线。 */
  function startNewConversation() {
    const token = login?.token;
    const conversation = createConversationRecord(transportKind);
    setMessages([]);
    setActiveConversationId(conversation.id);
    activeConversationIdRef.current = conversation.id;
    setConversations((current) => [conversation, ...current.map((item) => ({ ...item, active: false }))]);
    setInput("");
    resetConversationRuntime();
    setConversationConnectionState(conversation.id, "disconnected");
    setConversationConnectionError(conversation.id, null);
    setMobileSidebarOpen(false);

    if (token) {
      if (conversation.transportKind === "webrtc") {
        connectRtcConversation(conversation.id).catch(() => {
          // connectRtcConversation 已负责写入错误信息。
        });
      } else {
        openAgentSocket(token, conversation.id);
      }
    }
  }

  /** 切换到浏览器本地保存的会话；如果该会话连接仍在线，继续复用原 WebSocket。 */
  function selectConversation(sessionId: string) {
    const conversation = conversations.find((item) => item.id === sessionId);
    if (!conversation || conversation.id === activeConversationId) {
      setMobileSidebarOpen(false);
      return;
    }

    setActiveConversationId(conversation.id);
    activeConversationIdRef.current = conversation.id;
    setMessages(conversation.messages);
    setInput("");
    setSessionId(conversation.sessionId ?? null);
    setCurrentTurnId(conversation.currentTurnId ?? null);
    setLatestMetrics(conversation.latestMetrics ?? null);
    setTransportKind(conversation.transportKind);
    currentTurnIdRef.current = conversation.currentTurnId ?? null;
    setTurnActive(conversation.messages.some((message) => message.streaming));
    stopMicrophone(false);
    stopPlayback("已切换到本地历史会话。");
    setMobileSidebarOpen(false);
  }

  /** 向指定会话追加消息，活动会话更新右侧视图，后台会话只更新本地快照。 */
  function appendConversationMessage(sessionId: string, message: ChatMessage) {
    updateConversationMessages(sessionId, (current) => [...current, message]);
  }

  /** 更新指定会话消息，后台 WebSocket 事件不会因为切换会话而写到错误的消息流。 */
  function updateConversationMessages(sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) {
    if (sessionId === activeConversationIdRef.current) {
      setMessages(updater);
      return;
    }
    setConversations((current) =>
      current.map((conversation) => {
        if (conversation.id !== sessionId) {
          return conversation;
        }
        const nextMessages = updater(conversation.messages);
        return {
          ...conversation,
          messages: nextMessages,
          preview: buildConversationPreview(nextMessages, conversation.preview),
          updatedAtMs: Date.now(),
        };
      }),
    );
  }

  /** 更新指定会话最近一次完成轮次的指标快照。 */
  function updateConversationLatestMetrics(conversationId: string, metrics: TurnMetricsView | null) {
    if (conversationId === activeConversationIdRef.current) {
      setLatestMetrics(metrics);
    }
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              latestMetrics: metrics,
              updatedAtMs: Date.now(),
            }
          : conversation,
      ),
    );
  }

  /** 查询指定会话当前使用的传输模式。 */
  function resolveConversationTransportKind(sessionId: string) {
    return conversations.find((conversation) => conversation.id === sessionId)?.transportKind ?? "ws-pcm";
  }

  /** 把服务端下发的 RTC ICE candidate 添加到对应会话的 PeerConnection。 */
  function addRemoteRtcIceCandidate(sessionId: string, event: AgentEventEnvelope) {
    const runtime = rtcConnectionsRef.current.get(sessionId);
    const candidate = readPayloadText(event, "candidate");
    if (!runtime || !candidate) {
      return;
    }
    runtime.peerConnection
      .addIceCandidate({
        candidate,
        sdpMid: readPayloadText(event, "sdpMid") || null,
        sdpMLineIndex: readPayloadNumber(event, "sdpMLineIndex", 0),
      })
      .catch(() => {
        setConversationConnectionError(sessionId, "添加远端 RTC candidate 失败。");
      });
  }

  /** 根据后端 rtc_state_changed 事件同步当前会话的 RTC 调试状态。 */
  function handleRtcStateChanged(sessionId: string, event: AgentEventEnvelope) {
    const state = readPayloadText(event, "state");
    const source = readPayloadText(event, "source");
    const detail = readPayloadText(event, "detail");
    if (!state) {
      return;
    }

    if (state === "connected") {
      setConversationConnectionError(sessionId, null);
    } else if (state === "disconnected" || state === "failed") {
      setConversationConnectionError(sessionId, formatRtcStateMessage(state, source, detail));
    } else if (state === "closed" && detail === "rtc_close") {
      setConversationConnectionError(sessionId, null);
    }

    if (sessionId !== activeConversationIdRef.current) {
      return;
    }

    switch (state) {
      case "session_opened":
        setAudioInputStatus("WebRTC 会话已初始化，等待 SDP 协商");
        setPlaybackStatus("等待 RTC 远端音轨");
        break;
      case "track_bound":
        setPlaybackStatus("服务端已绑定远端 RTC 音轨");
        break;
      case "media_flowing":
        setAudioInputStatus("WebRTC 音频已进入后端");
        break;
      case "connected":
        setAudioInputStatus("WebRTC 麦克风已连接");
        if (source === "peer_connection") {
          setPlaybackStatus("RTC 媒体链路已连通");
        }
        break;
      case "disconnected":
        setAudioInputStatus("WebRTC 媒体已断开，等待自动恢复");
        setPlaybackStatus("等待 RTC 重连");
        break;
      case "failed":
        setAudioInputStatus("WebRTC 媒体建链失败");
        setPlaybackStatus("等待 RTC 重连");
        break;
      case "closed":
        setAudioInputStatus("WebRTC 麦克风未连接");
        if (detail === "rtc_close") {
          setPlaybackStatus("RTC 会话已关闭");
        }
        break;
      default:
        break;
    }
  }

  /** 暂停连续通话的 PCM 上传，但保留麦克风权限和音频节点。 */
  function pauseContinuousListening(status: string) {
    if (!continuousCallActiveRef.current) {
      return;
    }
    microphoneUploadEnabledRef.current = false;
    if (resumeListeningTimerRef.current !== null) {
      window.clearTimeout(resumeListeningTimerRef.current);
      resumeListeningTimerRef.current = null;
    }
    setAudioInputStatus(status);
  }

  /** Agent 文本和本地 TTS 播放都结束后，自动进入下一轮聆听。 */
  function scheduleContinuousListeningResume(delayMs = 900) {
    if (!continuousCallActiveRef.current || !assistantTextFinishedRef.current) {
      return;
    }
    if (resumeListeningTimerRef.current !== null) {
      window.clearTimeout(resumeListeningTimerRef.current);
    }
    resumeListeningTimerRef.current = window.setTimeout(() => {
      resumeListeningTimerRef.current = null;
      const socket = activeSocket();
      if (
        !continuousCallActiveRef.current ||
        !assistantTextFinishedRef.current ||
        playingAudioRef.current ||
        playbackQueueRef.current.length > 0 ||
        socket?.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      assistantTextFinishedRef.current = false;
      microphoneUploadEnabledRef.current = true;
      setTurnActive(false);
      setAudioInputStatus("通话中，正在聆听");
    }, delayMs);
  }

  /** 处理后端下行事件并映射为聊天消息。 */
  function handleAgentEvent(sessionId: string, event: AgentEventEnvelope) {
    const active = sessionId === activeConversationIdRef.current;
    if (event.sessionId) {
      if (active) {
        setSessionId(event.sessionId);
      }
      updateConversationSessionTitle(sessionId, event.sessionId);
    }
    if (event.turnId) {
      if (active) {
        setCurrentTurnId(event.turnId);
      }
      updateConversationTurnId(sessionId, event.turnId);
    }

    switch (event.type) {
      case "state_changed": {
        const state = readPayloadText(event, "state");
        if (
          active &&
          recordingRef.current &&
          resolveConversationTransportKind(sessionId) === "ws-pcm" &&
          (state === "USER_TURN_COMMITTED" || state === "AGENT_THINKING" || state === "AGENT_SPEAKING")
        ) {
          assistantTextFinishedRef.current = false;
          pauseContinuousListening("本轮语音已提交，等待回复");
        }
        break;
      }
      case "asr_final":
        upsertUserMessage(sessionId, event);
        break;
      case "agent_thinking":
        if (active) {
          setTurnActive(true);
        }
        upsertAssistantMessage(sessionId, event, "正在思考...", true);
        break;
      case "agent_text_chunk":
        if (active && event.payload?.["isLast"] === true) {
          assistantTextFinishedRef.current = true;
          if (!playingAudioRef.current && playbackQueueRef.current.length === 0) {
            // 没有音频返回时仍需恢复监听；若 TTS 随后到达，会取消这次兜底恢复。
            scheduleContinuousListeningResume(3_000);
          }
        }
        appendAssistantChunk(sessionId, event);
        break;
      case "tts_audio_chunk":
        if (active) {
          setTurnActive(true);
          if (resolveConversationTransportKind(sessionId) === "ws-pcm") {
            enqueueTtsAudio(event);
          } else {
            setPlaybackStatus("RTC 远端音轨播放中");
          }
        }
        if (event.payload?.["isLast"] === true) {
          updateConversationMessages(sessionId, (current) => markStreamingDone(current));
        }
        break;
      case "turn_metrics":
        handleTurnMetricsEvent(sessionId, event);
        break;
      case "rtc_ice_candidate":
        addRemoteRtcIceCandidate(sessionId, event);
        break;
      case "rtc_state_changed":
        handleRtcStateChanged(sessionId, event);
        break;
      case "turn_interrupted":
      case "playback_stop":
        if (event.turnId) {
          invalidTurnIdsRef.current.add(event.turnId);
        }
        if (active) {
          setTurnActive(false);
          stopPlayback("当前播报已停止。");
          assistantTextFinishedRef.current = true;
          scheduleContinuousListeningResume(300);
        }
        updateConversationMessages(sessionId, (current) => markStreamingDone(current));
        break;
      case "error":
        if (active) {
          setTurnActive(false);
          stopPlayback("后端返回错误。");
          assistantTextFinishedRef.current = true;
          scheduleContinuousListeningResume(300);
        }
        updateConversationMessages(sessionId, (current) => [
          ...markStreamingDone(current),
          systemMessage(readPayloadText(event, "message") || "后端返回错误。"),
        ]);
        break;
      default:
        break;
    }
  }

  /** 在一轮对话结束后，把后端耗时指标整理成易读摘要。 */
  function handleTurnMetricsEvent(sessionId: string, event: AgentEventEnvelope) {
    const stage = readPayloadText(event, "stage");
    const metrics = buildTurnMetricsView(event);
    if (metrics) {
      updateConversationLatestMetrics(sessionId, metrics);
    }
    if (stage !== "tts_completed") {
      return;
    }
    const summary = formatTurnMetricsSummary(event);
    if (!summary) {
      return;
    }
    updateConversationMessages(sessionId, (current) => {
      const alreadyExists = current.some(
        (message) => message.role === "system" && message.turnId === event.turnId && message.content === summary,
      );
      if (alreadyExists) {
        return current;
      }
      return [
        ...current,
        {
          ...systemMessage(summary),
          turnId: event.turnId,
        },
      ];
    });
  }

  /** 将 asr_final 事件固化为用户消息。 */
  function upsertUserMessage(sessionId: string, event: AgentEventEnvelope) {
    const text = readPayloadText(event, "text");
    if (!text) {
      return;
    }
    updateConversationMessages(sessionId, (current) => {
      if (current.some((message) => message.role === "user" && message.turnId === event.turnId)) {
        return current;
      }
      return [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "user",
          content: text,
          turnId: event.turnId,
          createdAt: new Date(),
        },
      ];
    });
    updateConversationHistory(sessionId, text);
  }

  /** 创建或更新当前 turn 的助手消息。 */
  function upsertAssistantMessage(sessionId: string, event: AgentEventEnvelope, content: string, streaming: boolean) {
    updateConversationMessages(sessionId, (current) => {
      const index = current.findIndex((message) => message.role === "assistant" && message.turnId === event.turnId);
      if (index >= 0) {
        return current.map((message, messageIndex) =>
          messageIndex === index ? { ...message, content, streaming } : message,
        );
      }
      return [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content,
          turnId: event.turnId,
          streaming,
          createdAt: new Date(),
        },
      ];
    });
  }

  /** 把 agent_text_chunk 追加到当前助手气泡。 */
  function appendAssistantChunk(sessionId: string, event: AgentEventEnvelope) {
    const text = readPayloadText(event, "text");
    if (!text) {
      return;
    }
    updateConversationMessages(sessionId, (current) => {
      const index = current.findIndex((message) => message.role === "assistant" && message.turnId === event.turnId);
      if (index >= 0) {
        return current.map((message, messageIndex) =>
          messageIndex === index
            ? {
                ...message,
                content: message.content === "正在思考..." ? text : `${message.content}${text}`,
                streaming: !event.payload?.["isLast"],
              }
            : message,
        );
      }
      return [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: text,
          turnId: event.turnId,
          streaming: !event.payload?.["isLast"],
          createdAt: new Date(),
        },
      ];
    });
  }

  /** 收到 TTS 音频后入队并启动播放，同时驱动助手文字区的播放动效。 */
  function enqueueTtsAudio(event: AgentEventEnvelope) {
    const turnId = event.turnId;
    const audioBase64 = readPayloadText(event, "audioBase64");
    if (!turnId || !audioBase64) {
      return;
    }
    if (currentTurnIdRef.current && turnId !== currentTurnIdRef.current) {
      return;
    }
    if (invalidTurnIdsRef.current.has(turnId)) {
      return;
    }

    pauseContinuousListening("回答播报中");

    playbackQueueRef.current.push({
      turnId,
      seq: readPayloadNumber(event, "seq", playbackQueueRef.current.length),
      audioBase64,
    });
    playbackQueueRef.current.sort((left, right) => left.seq - right.seq);
    setPlaybackStatus(`待播放 ${playbackQueueRef.current.length} 段`);
    drainPlaybackQueue().catch((error: unknown) => {
      setPlaybackStatus(error instanceof Error ? `播放失败：${error.message}` : "播放失败");
      clearSpeakingState();
    });
  }

  /** 顺序消费 TTS 队列，避免同一 turn 内的音频片段重叠播放。 */
  async function drainPlaybackQueue() {
    if (playingAudioRef.current) {
      return;
    }
    playingAudioRef.current = true;
    try {
      while (playbackQueueRef.current.length > 0) {
        const item = playbackQueueRef.current.shift();
        if (!item || item.turnId !== currentTurnIdRef.current || invalidTurnIdsRef.current.has(item.turnId)) {
          continue;
        }
        setAssistantSpeaking(item.turnId, true);
        setPlaybackStatus(`正在播放 seq=${item.seq}`);
        await playTtsAudio(item.audioBase64);
      }
    } finally {
      playingAudioRef.current = false;
      currentAudioSourceRef.current = null;
      clearSpeakingState();
      setMessages((current) => markStreamingDone(current));
      setPlaybackStatus("等待 TTS");
      setTurnActive(false);
      scheduleContinuousListeningResume();
    }
  }

  /** 播放 TTS 音频，优先走浏览器解码，失败时按 PCM16 little-endian 兜底。 */
  async function playTtsAudio(audioBase64: string) {
    const context = await ensureAudioContext();
    const bytes = base64ToBytes(audioBase64);
    try {
      const decoded = await context.decodeAudioData(bytes.buffer.slice(0));
      await playAudioBuffer(decoded);
    } catch {
      await playPcm16(bytes);
    }
  }

  /** 确保 AudioContext 可用，并在浏览器需要用户手势时尝试恢复。 */
  async function ensureAudioContext() {
    audioContextRef.current = audioContextRef.current || new AudioContext();
    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }

  /** 播放浏览器已解码的音频缓冲。 */
  async function playAudioBuffer(buffer: AudioBuffer) {
    const context = await ensureAudioContext();
    await new Promise<void>((resolve) => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      currentAudioSourceRef.current = source;
      source.onended = () => resolve();
      source.start();
    });
  }

  /** 当 TTS 返回裸 PCM 时，按默认 24kHz PCM16 单声道进行兜底播放。 */
  async function playPcm16(bytes: Uint8Array) {
    const context = await ensureAudioContext();
    const sampleRate = 24000;
    const sampleCount = Math.floor(bytes.length / 2);
    const audioBuffer = context.createBuffer(1, sampleCount, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let index = 0; index < sampleCount; index += 1) {
      const low = bytes[index * 2];
      const high = bytes[index * 2 + 1];
      const sample = (high << 8) | low;
      const signed = sample >= 0x8000 ? sample - 0x10000 : sample;
      channel[index] = Math.max(-1, Math.min(1, signed / 0x8000));
    }
    await playAudioBuffer(audioBuffer);
  }

  /** 停止当前 TTS 播放并清空队列。 */
  function stopPlayback(reason: string) {
    playbackQueueRef.current = [];
    if (currentAudioSourceRef.current) {
      try {
        currentAudioSourceRef.current.stop();
      } catch {
        // 音频节点可能已经自然结束，停止失败不影响状态清理。
      }
    }
    currentAudioSourceRef.current = null;
    playingAudioRef.current = false;
    clearSpeakingState();
    setPlaybackStatus(reason);
  }

  /** 标记指定 turn 的助手消息正在播放 TTS。 */
  function setAssistantSpeaking(turnId: string, speaking: boolean) {
    setMessages((current) =>
      current.map((message) =>
        message.role === "assistant" && message.turnId === turnId ? { ...message, speaking } : message,
      ),
    );
  }

  /** 清除所有助手消息的 TTS 播放动效。 */
  function clearSpeakingState() {
    setMessages((current) => current.map((message) => (message.speaking ? { ...message, speaking: false } : message)));
  }

  /** 发送用户输入的文本消息。 */
  function sendTextMessage(textOverride?: string) {
    const text = (textOverride ?? input).trim();
    const socket = activeSocket();
    if (!text || !socket || !connected) {
      return;
    }

    setInput("");
    setTurnActive(true);
    sendWsJson(socket, "text", { text });
  }

  /** 发送打断消息，让后端停止旧 turn。 */
  function interruptTurn() {
    const socket = activeSocket();
    if (!socket || !connected) {
      return;
    }
    sendWsJson(socket, "interrupt", { reason: "client_interrupt" });
    if (currentTurnId) {
      invalidTurnIdsRef.current.add(currentTurnId);
    }
    setTurnActive(false);
    stopPlayback("已发送打断。");
    setMessages((current) => [...markStreamingDone(current), systemMessage("已发送打断请求。")]);
  }

  /** 切换连续通话状态；WS PCM 模式下一次开启后会在多轮问答间自动恢复监听。 */
  async function toggleMicrophone() {
    if (transportKind === "webrtc") {
      const runtime = rtcConnectionsRef.current.get(activeConversationIdRef.current);
      const socket = activeSocket();
      if (!runtime) {
        return;
      }
      const nextEnabled = !recordingRef.current;
      runtime.localStream.getAudioTracks().forEach((track) => {
        track.enabled = nextEnabled;
      });
      recordingRef.current = nextEnabled;
      setRecording(nextEnabled);
      setAudioInputStatus(nextEnabled ? "WebRTC 麦克风已开启" : "WebRTC 麦克风已静音");
      if (!nextEnabled && socket?.readyState === WebSocket.OPEN) {
        sendWsJson(socket, "audio_end", {});
      }
      return;
    }
    if (recording) {
      stopMicrophone(true);
      return;
    }
    await startMicrophone();
  }

  /** 打开连续通话并把浏览器音频重采样为后端默认 PCM16 二进制帧。 */
  async function startMicrophone() {
    const currentSocket = activeSocket();
    if (!currentSocket || !connected || recordingRef.current) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setAudioInputStatus("当前浏览器不支持麦克风采集");
      setMessages((current) => [...current, systemMessage("当前浏览器不支持麦克风采集。")]);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const mute = context.createGain();
      mute.gain.value = 0;

      processor.onaudioprocess = (event) => {
        const socket = activeSocket();
        if (
          !recordingRef.current ||
          !microphoneUploadEnabledRef.current ||
          !socket ||
          socket.readyState !== WebSocket.OPEN
        ) {
          return;
        }
        const channel = event.inputBuffer.getChannelData(0);
        const pcm = floatToPcm16(channel, context.sampleRate, MICROPHONE_TARGET_SAMPLE_RATE);
        if (pcm.byteLength > 0) {
          socket.send(pcm);
        }
      };

      source.connect(processor);
      processor.connect(mute);
      mute.connect(context.destination);

      microphoneStreamRef.current = stream;
      microphoneContextRef.current = context;
      microphoneSourceRef.current = source;
      microphoneProcessorRef.current = processor;
      microphoneMuteRef.current = mute;
      recordingRef.current = true;
      continuousCallActiveRef.current = true;
      microphoneUploadEnabledRef.current = true;
      assistantTextFinishedRef.current = false;
      setRecording(true);
      setAudioInputStatus("通话中，正在聆听");
      setMessages((current) => [...current, systemMessage("连续通话已开启；说完后会自动提交，回答结束后会继续聆听。")]);
    } catch (error) {
      setRecording(false);
      recordingRef.current = false;
      const message = error instanceof Error ? error.message : "麦克风开启失败";
      setAudioInputStatus(`麦克风开启失败：${message}`);
      setMessages((current) => [...current, systemMessage(`麦克风开启失败：${message}`)]);
      stopMicrophone(false);
    }
  }

  /** 处理输入框快捷键，Enter 发送，Shift+Enter 换行。 */
  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendTextMessage();
    }
  }

  /** 更新左侧指定会话摘要。 */
  function updateConversationHistory(sessionId: string, preview: string) {
    setConversations((current) =>
      current.map((item) =>
        item.id === sessionId
          ? {
              ...item,
              preview,
              updatedAtMs: Date.now(),
            }
          : item,
      ),
    );
  }

  /** 更新指定会话的传输模式，确保本地会话快照与当前 UI 选择一致。 */
  function updateConversationTransportKind(sessionId: string, nextTransportKind: TransportKind) {
    setConversations((current) =>
      current.map((item) =>
        item.id === sessionId
          ? {
              ...item,
              transportKind: nextTransportKind,
              updatedAtMs: Date.now(),
            }
          : item,
      ),
    );
  }

  /** 根据后端下行 sessionId 更新指定会话标题，帮助确认新对话已经对应新连接。 */
  function updateConversationSessionTitle(sessionId: string, nextSessionId: string) {
    setConversations((current) =>
      current.map((item) =>
        item.id === sessionId
          ? {
              ...item,
              title: `session ${nextSessionId}`,
              sessionId: nextSessionId,
              updatedAtMs: Date.now(),
            }
          : item,
      ),
    );
  }

  /** 保存指定会话最近一次活跃 turnId，便于切回会话时恢复本地运行态。 */
  function updateConversationTurnId(sessionId: string, nextTurnId: string) {
    setConversations((current) =>
      current.map((item) =>
        item.id === sessionId
          ? {
              ...item,
              currentTurnId: nextTurnId,
              updatedAtMs: Date.now(),
            }
          : item,
      ),
    );
  }

  /** 切换当前会话的传输模式，并在会话已在线时按新模式立即重连。 */
  function switchTransportKind(nextTransportKind: TransportKind) {
    if (nextTransportKind === transportKind) {
      return;
    }

    const conversationId = activeConversationIdRef.current;
    const shouldReconnect = Boolean(
      login?.token && (socketsRef.current.has(conversationId) || rtcConnectionsRef.current.has(conversationId)),
    );

    stopMicrophone(false);
    closeConversationRtc(conversationId);
    closeConversationSocket(conversationId);
    updateConversationTransportKind(conversationId, nextTransportKind);
    setTransportKind(nextTransportKind);
    setSessionId(null);
    setCurrentTurnId(null);
    currentTurnIdRef.current = null;
    invalidTurnIdsRef.current.clear();
    setTurnActive(false);
    setPlaybackStatus(nextTransportKind === "webrtc" ? "等待 RTC 远端音轨" : "等待 TTS");
    setAudioInputStatus(nextTransportKind === "webrtc" ? "WebRTC 麦克风未连接" : "麦克风未开启");
    setMessages((current) => [
      ...markStreamingDone(current),
      systemMessage(`已切换到 ${nextTransportKind === "webrtc" ? "WebRTC" : "WS PCM"} 模式。`),
    ]);

    if (!shouldReconnect || !login?.token) {
      return;
    }
    if (nextTransportKind === "webrtc") {
      connectRtcConversation(conversationId).catch(() => {
        // connectRtcConversation 已负责写入错误信息。
      });
      return;
    }
    openAgentSocket(login.token, conversationId);
  }

  return (
    <main className="relative flex h-screen overflow-hidden bg-background text-foreground">
      {mobileSidebarOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-foreground/24 backdrop-blur-[1px] lg:hidden"
          aria-label="关闭侧边栏遮罩"
          onClick={() => setMobileSidebarOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[min(86vw,320px)] flex-col border-r bg-sidebar px-3 py-4 transition-transform duration-200 lg:static lg:z-10 lg:w-72 lg:translate-x-0",
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full",
          !sidebarOpen && "lg:w-[76px]",
        )}
      >
        <SidebarContent
          compact={!sidebarOpen}
          history={history}
          login={login}
          loginOpen={loginOpen}
          loginError={loginError}
          loginForm={loginForm}
          loginLoading={loginLoading}
          connectionState={connectionState}
          connectionLabel={connectionLabel}
          connected={connected}
          onCloseMobile={() => setMobileSidebarOpen(false)}
          onToggleDesktop={() => setSidebarOpen((current) => !current)}
          onNewConversation={startNewConversation}
          onSelectConversation={selectConversation}
          onOpenChange={setLoginOpen}
          onLogin={handleLogin}
          onLogout={handleLogout}
          onUpdateField={updateLoginField}
          onConnect={connectSocket}
          onDisconnect={disconnectSocket}
        />
      </aside>

      <section className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b bg-background/92 px-3 backdrop-blur-xl md:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="lg:hidden"
              title="打开侧边栏"
              onClick={() => setMobileSidebarOpen(true)}
            >
              <Menu className="size-5" />
            </Button>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold md:text-base">本地语音助手</h1>
              <p className="truncate text-xs text-muted-foreground">
                {sessionId ? `session ${sessionId}` : "登录后连接本地 Agent"}
                {currentTurnId ? ` · turn ${currentTurnId}` : ""}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <div className="hidden items-center gap-1 rounded-full border bg-background/80 p-1 md:flex">
              <Button
                type="button"
                variant={transportKind === "ws-pcm" ? "secondary" : "ghost"}
                size="sm"
                className="h-8 rounded-full px-3 text-xs"
                onClick={() => switchTransportKind("ws-pcm")}
              >
                WS PCM
              </Button>
              <Button
                type="button"
                variant={transportKind === "webrtc" ? "secondary" : "ghost"}
                size="sm"
                className="h-8 rounded-full px-3 text-xs"
                onClick={() => switchTransportKind("webrtc")}
              >
                WebRTC
              </Button>
            </div>
            <ConnectionBadge state={connectionState} label={connectionLabel} />
            <Button type="button" variant="ghost" size="icon" title="切换主题" onClick={toggleTheme}>
              {theme === "dark" ? <Sun className="size-5" /> : <Moon className="size-5" />}
            </Button>
          </div>
        </header>

        {connectionError ? (
          <div className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive md:px-6">{connectionError}</div>
        ) : null}

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pb-40 pt-6 md:px-8 md:pb-44">
          <div className="mx-auto flex min-h-full max-w-3xl flex-col">
            <TurnMetricsPanel metrics={latestMetrics} />
            {emptyConversation ? (
              <EmptyConversation connected={connected} onUsePrompt={sendTextMessage} />
            ) : (
              <div className="mt-6 flex flex-col gap-6">
                {messages.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background/96 to-transparent px-4 pb-4 pt-10 md:px-8">
          <div className="pointer-events-auto mx-auto max-w-3xl">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                {recording ? <Mic className="size-3.5 text-primary" /> : <Volume2 className="size-3.5 text-primary" />}
                <span className="truncate">{recording ? audioInputStatus : playbackStatus}</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                {connected ? <CheckCircle2 className="size-3.5 text-primary" /> : <WifiOff className="size-3.5" />}
                {connected
                  ? transportKind === "webrtc"
                    ? "WebSocket 控制面 · WebRTC 音频面"
                    : "连续通话 · 自动断句与恢复监听"
                  : "当前连接不可用"}
              </span>
            </div>
            <div className="flex items-end gap-2 rounded-[1.35rem] border bg-input-shell p-2 shadow-[0_18px_45px_hsl(var(--foreground)/0.10)]">
              <Button
                type="button"
                variant={recording ? "destructive" : "ghost"}
                size="icon"
                className="mb-1 shrink-0"
                title={recording ? "结束连续通话" : "开始连续通话"}
                disabled={!connected}
                onClick={() => {
                  toggleMicrophone().catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : "麦克风开启失败";
                    setAudioInputStatus(`麦克风开启失败：${message}`);
                  });
                }}
              >
                {recording ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              </Button>
              <Textarea
                value={input}
                className="min-h-20 flex-1 border-0 bg-transparent px-3 py-3 shadow-none focus-visible:ring-0"
                placeholder={connected ? "给 Kong Voice Agent 发送消息" : "请先登录并连接后端"}
                disabled={!connected}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleInputKeyDown}
              />
              <Button
                type="button"
                size="icon"
                className="mb-1 shrink-0"
                title={turnActive ? "打断当前回复" : "发送消息"}
                disabled={!connected || (!turnActive && !input.trim())}
                onClick={() => {
                  if (turnActive) {
                    interruptTurn();
                    return;
                  }
                  sendTextMessage();
                }}
              >
                {turnActive ? <Square className="size-4" /> : <Send className="size-4" />}
              </Button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

/** 侧边栏属性集合。 */
interface SidebarContentProps extends LoginPanelProps {
  /** 是否已经建立连接。 */
  connected: boolean;
  /** 当前历史会话。 */
  history: ConversationSummary[];
  /** WebSocket 状态。 */
  connectionState: ConnectionState;
  /** WebSocket 状态文案。 */
  connectionLabel: string;
  /** 关闭移动端侧边栏。 */
  onCloseMobile: () => void;
  /** 折叠或展开桌面端侧边栏。 */
  onToggleDesktop: () => void;
  /** 新建会话并打开独立 WebSocket session。 */
  onNewConversation: () => void;
  /** 切换到浏览器本地保存的会话记录。 */
  onSelectConversation: (sessionId: string) => void;
  /** 建立 WebSocket 连接。 */
  onConnect: () => void;
  /** 断开 WebSocket 连接。 */
  onDisconnect: () => void;
}

/** 左侧产品化会话栏，承载品牌、新会话、历史、连接和账号入口。 */
function SidebarContent({
  compact,
  history,
  login,
  loginOpen,
  loginError,
  loginForm,
  loginLoading,
  connectionState,
  connectionLabel,
  connected,
  onCloseMobile,
  onToggleDesktop,
  onNewConversation,
  onSelectConversation,
  onOpenChange,
  onLogin,
  onLogout,
  onUpdateField,
  onConnect,
  onDisconnect,
}: SidebarContentProps) {
  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-2">
        {compact ? null : (
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Sparkles className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Kong Voice Agent</p>
              <p className="truncate text-xs text-muted-foreground">AI Chat</p>
            </div>
          </div>
        )}
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="hidden lg:inline-flex"
            title={compact ? "展开侧边栏" : "收起侧边栏"}
            onClick={onToggleDesktop}
          >
            {compact ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
          </Button>
          <Button type="button" variant="ghost" size="icon" className="lg:hidden" title="关闭侧边栏" onClick={onCloseMobile}>
            <X className="size-5" />
          </Button>
        </div>
      </div>

      <Button
        type="button"
        variant="secondary"
        className={cn("mb-3 justify-start rounded-xl", compact && "justify-center px-0")}
        title="新建会话"
        onClick={onNewConversation}
      >
        <MessageSquarePlus className="size-4" />
        {compact ? null : "新对话"}
      </Button>

      <div className="flex-1 overflow-y-auto py-2">
        {compact ? null : <p className="mb-2 px-2 text-xs font-medium text-muted-foreground">最近对话</p>}
        <div className="space-y-1">
          {history.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn(
                "group flex w-full items-center gap-2 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-secondary",
                item.active ? "bg-secondary" : "bg-transparent",
                compact && "justify-center px-2",
              )}
              title={item.title}
              onClick={() => onSelectConversation(item.id)}
            >
              <History className="size-4 shrink-0 text-muted-foreground" />
              {compact ? null : (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.preview}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{item.updatedAt}</span>
                </>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2 border-t pt-3">
        <div className={cn("rounded-xl bg-background/70 p-2", compact && "flex justify-center")}>
          {compact ? (
            <ConnectionStateIcon state={connectionState} />
          ) : (
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <ConnectionStateIcon state={connectionState} />
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{connectionLabel}</p>
                  <p className="truncate text-xs text-muted-foreground">{login ? "token 已就绪" : "请先登录"}</p>
                </div>
              </div>
              {connected ? (
                <Button type="button" variant="ghost" size="icon" title="断开连接" onClick={onDisconnect}>
                  <WifiOff className="size-4" />
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title="连接后端"
                  disabled={!login || connectionState === "connecting"}
                  onClick={onConnect}
                >
                  {connectionState === "connecting" ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
                </Button>
              )}
            </div>
          )}
        </div>

        <LoginPanel
          compact={compact}
          login={login}
          loginOpen={loginOpen}
          loginError={loginError}
          loginForm={loginForm}
          loginLoading={loginLoading}
          onOpenChange={onOpenChange}
          onLogin={onLogin}
          onLogout={onLogout}
          onUpdateField={onUpdateField}
        />
      </div>
    </>
  );
}

/** 登录区属性集合。 */
interface LoginPanelProps {
  /** 是否使用收起态布局。 */
  compact: boolean;
  /** 当前登录信息。 */
  login: LoginResponse | null;
  /** 登录弹窗是否打开。 */
  loginOpen: boolean;
  /** 登录失败提示。 */
  loginError: string | null;
  /** 登录表单值。 */
  loginForm: typeof DEFAULT_LOGIN_FORM;
  /** 登录请求是否进行中。 */
  loginLoading: boolean;
  /** 更新弹窗打开状态。 */
  onOpenChange: (open: boolean) => void;
  /** 提交登录表单。 */
  onLogin: (event: FormEvent<HTMLFormElement>) => void;
  /** 注销当前用户。 */
  onLogout: () => void;
  /** 更新登录表单字段。 */
  onUpdateField: (field: keyof typeof DEFAULT_LOGIN_FORM, value: string) => void;
}

/** 左下角登录组件，符合聊天产品账号入口的低干扰位置。 */
function LoginPanel({
  compact,
  login,
  loginOpen,
  loginError,
  loginForm,
  loginLoading,
  onOpenChange,
  onLogin,
  onLogout,
  onUpdateField,
}: LoginPanelProps) {
  if (login) {
    return (
      <div className={cn("flex items-center gap-3 rounded-xl bg-background/70 p-2", compact && "justify-center")}>
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary">
          <UserRound className="size-5" />
        </div>
        {compact ? null : (
          <>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{login.user.username}</p>
              <p className="truncate text-xs text-muted-foreground">{login.user.accountId}</p>
            </div>
            <Button type="button" variant="ghost" size="icon" title="退出登录" onClick={onLogout}>
              <LogOut className="size-5" />
            </Button>
          </>
        )}
      </div>
    );
  }

  return (
    <Dialog open={loginOpen} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" className={cn("w-full rounded-xl", compact && "px-0")} size={compact ? "icon" : "default"}>
          <LogIn className="size-4" />
          {compact ? null : "登录"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>登录到本地后端</DialogTitle>
        <DialogDescription>使用固定账号获取 WebSocket token。</DialogDescription>
        <form className="space-y-4" onSubmit={onLogin}>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="username">
              用户名
            </label>
            <Input
              id="username"
              value={loginForm.username}
              autoComplete="username"
              onChange={(event) => onUpdateField("username", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="password">
              密码
            </label>
            <Input
              id="password"
              type="password"
              value={loginForm.password}
              autoComplete="current-password"
              onChange={(event) => onUpdateField("password", event.target.value)}
            />
          </div>
          {loginError ? <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{loginError}</p> : null}
          <Button type="submit" className="w-full" disabled={loginLoading}>
            {loginLoading ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
            登录
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 连接状态标签属性。 */
interface ConnectionBadgeProps {
  /** WebSocket 状态。 */
  state: ConnectionState;
  /** 状态展示文案。 */
  label: string;
}

/** 顶部连接状态标签。 */
function ConnectionBadge({ state, label }: ConnectionBadgeProps) {
  return (
    <span
      className={cn(
        "hidden items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium sm:inline-flex",
        state === "connected" && "bg-primary/12 text-primary",
        state === "connecting" && "bg-accent/25 text-accent-foreground",
        state === "disconnected" && "bg-secondary text-muted-foreground",
      )}
    >
      <ConnectionStateIcon state={state} />
      {label}
    </span>
  );
}

/** 连接状态图标属性。 */
interface ConnectionStateIconProps {
  /** WebSocket 状态。 */
  state: ConnectionState;
}

/** 根据 WebSocket 状态渲染一致的状态图标。 */
function ConnectionStateIcon({ state }: ConnectionStateIconProps) {
  if (state === "connected") {
    return <Wifi className="size-3.5 text-primary" />;
  }
  if (state === "connecting") {
    return <RefreshCw className="size-3.5 animate-spin text-accent-foreground" />;
  }
  return <WifiOff className="size-3.5 text-muted-foreground" />;
}

/** 空会话属性。 */
interface EmptyConversationProps {
  /** 是否已经连接到后端。 */
  connected: boolean;
  /** 点击建议问题时发送文本。 */
  onUsePrompt: (prompt: string) => void;
}

/** 首屏欢迎态，用更产品化的方式提示用户开始对话。 */
function EmptyConversation({ connected, onUsePrompt }: EmptyConversationProps) {
  return (
    <div className="mx-auto flex min-h-[58vh] w-full max-w-2xl flex-col items-center justify-center text-center">
      <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-[0_14px_36px_hsl(var(--primary)/0.20)]">
        <Bot className="size-7" />
      </div>
      <h2 className="text-2xl font-semibold tracking-normal md:text-3xl">今天想和本地 Agent 聊什么？</h2>
      <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
        登录并连接后，可以直接发送文本消息，页面会按 turnId 聚合回复并自动播放 TTS。
      </p>
      <div className="mt-7 grid w-full gap-2 sm:grid-cols-3">
        {STARTER_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            disabled={!connected}
            className="group rounded-2xl border bg-card px-4 py-3 text-left text-sm transition-colors hover:border-primary/45 hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-55"
            onClick={() => onUsePrompt(prompt)}
          >
            <span className="line-clamp-2 min-h-10">{prompt}</span>
            <span className="mt-3 flex items-center text-xs text-muted-foreground">
              发送
              <ChevronRight className="ml-1 size-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 消息气泡属性。 */
interface MessageBubbleProps {
  /** 需要渲染的一条聊天消息。 */
  message: ChatMessage;
}

/** 聊天消息气泡组件，区分用户、助手和系统消息。 */
function MessageBubble({ message }: MessageBubbleProps) {
  if (message.role === "system") {
    return (
      <div className="mx-auto max-w-[88%] rounded-full bg-secondary/70 px-3 py-1.5 text-center text-xs text-muted-foreground">
        {message.content}
      </div>
    );
  }

  const isUser = message.role === "user";

  return (
    <div className={cn("flex gap-3", isUser ? "justify-end" : "justify-start")}>
      {!isUser ? (
        <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <Bot className="size-4.5" />
        </div>
      ) : null}
      <div
        className={cn(
          "relative max-w-[min(720px,84%)] overflow-hidden px-4 py-3 text-sm leading-7",
          isUser
            ? "rounded-2xl bg-primary text-primary-foreground"
            : "rounded-2xl border bg-card text-card-foreground shadow-[0_8px_24px_hsl(var(--foreground)/0.05)]",
          message.speaking && "speaking-message border-primary/35 bg-primary/8",
        )}
      >
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
        {message.speaking ? <VoiceWave /> : null}
        {message.streaming ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            生成中
          </div>
        ) : null}
      </div>
      {isUser ? (
        <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary">
          <UserRound className="size-4.5" />
        </div>
      ) : null}
    </div>
  );
}

/** TTS 播放时显示在助手文字区域下方的声波动效。 */
function VoiceWave() {
  return (
    <div className="mt-3 flex items-center gap-1.5 text-primary" aria-label="正在播放 TTS">
      {[0, 1, 2, 3, 4].map((index) => (
        <span
          key={index}
          className="voice-bar h-4 w-1 rounded-full bg-primary/80"
          style={{ animationDelay: `${index * 90}ms` }}
        />
      ))}
      <span className="ml-2 text-xs text-muted-foreground">正在播报</span>
    </div>
  );
}

/** 构造系统提示消息。 */
function systemMessage(content: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "system",
    content,
    createdAt: new Date(),
  };
}

/** 创建一条新的前端会话记录，真正的后端 session 会在连接成功后回填。 */
function createConversationRecord(transportKind: TransportKind = "ws-pcm"): ConversationRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "新会话",
    preview: "等待连接后端 session",
    updatedAt: "现在",
    active: true,
    sessionId: null,
    currentTurnId: null,
    latestMetrics: null,
    messages: [],
    transportKind,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

/** 从 localStorage 恢复会话列表，数据损坏时自动创建一条空会话。 */
function loadStoredConversations(): ConversationRecord[] {
  try {
    const raw = window.localStorage.getItem(CONVERSATION_STORAGE_KEY);
    if (!raw) {
      return [createConversationRecord()];
    }
    const parsed = JSON.parse(raw) as Partial<ConversationRecord>[];
    const conversations = parsed
      .map((item) => normalizeConversationRecord(item))
      .filter((item): item is ConversationRecord => Boolean(item));
    return conversations.length > 0 ? conversations : [createConversationRecord()];
  } catch {
    return [createConversationRecord()];
  }
}

/** 找到上次选中的会话；如果记录不存在，则默认使用最新会话。 */
function resolveInitialActiveConversation(conversations: ConversationRecord[]): ConversationRecord {
  const storedActiveId = window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY);
  return (
    conversations.find((conversation) => conversation.id === storedActiveId) ??
    conversations.slice().sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0] ??
    createConversationRecord()
  );
}

/** 标准化 localStorage 中的会话记录，兼容 Date 被序列化为字符串的情况。 */
function normalizeConversationRecord(item: Partial<ConversationRecord> | null | undefined): ConversationRecord | null {
  if (!item || typeof item.id !== "string") {
    return null;
  }
  const now = Date.now();
  const messages = Array.isArray(item.messages)
    ? item.messages.map(normalizeChatMessage).filter((message): message is ChatMessage => Boolean(message))
    : [];
  return {
    id: item.id,
    title: typeof item.title === "string" && item.title ? item.title : "历史会话",
    preview: typeof item.preview === "string" && item.preview ? item.preview : "本地保存的会话",
    updatedAt: "刚刚",
    active: false,
    sessionId: typeof item.sessionId === "string" ? item.sessionId : null,
    currentTurnId: typeof item.currentTurnId === "string" ? item.currentTurnId : null,
    latestMetrics: normalizeTurnMetricsView(item.latestMetrics),
    messages,
    transportKind: item.transportKind === "webrtc" ? "webrtc" : "ws-pcm",
    createdAtMs: typeof item.createdAtMs === "number" ? item.createdAtMs : now,
    updatedAtMs: typeof item.updatedAtMs === "number" ? item.updatedAtMs : now,
  };
}

/** 标准化本地消息记录，清理不应跨页面刷新的流式与播放状态。 */
function normalizeChatMessage(message: Partial<ChatMessage> | null | undefined): ChatMessage | null {
  if (!message || typeof message.id !== "string" || typeof message.content !== "string") {
    return null;
  }
  const role = message.role === "assistant" || message.role === "system" || message.role === "user" ? message.role : "system";
  return {
    id: message.id,
    role,
    content: message.content,
    turnId: typeof message.turnId === "string" ? message.turnId : null,
    streaming: false,
    speaking: false,
    createdAt: message.createdAt ? new Date(message.createdAt) : new Date(),
  };
}

/** 标准化本地缓存的指标快照。 */
function normalizeTurnMetricsView(metrics: unknown): TurnMetricsView | null {
  if (!metrics || typeof metrics !== "object") {
    return null;
  }
  const value = metrics as Partial<TurnMetricsView>;
  if (typeof value.stage !== "string") {
    return null;
  }
  return {
    turnId: typeof value.turnId === "string" ? value.turnId : null,
    stage: value.stage,
    source: typeof value.source === "string" ? value.source : "unknown",
    asrResponseLatencyMs: typeof value.asrResponseLatencyMs === "number" ? value.asrResponseLatencyMs : null,
    asrDurationMs: typeof value.asrDurationMs === "number" ? value.asrDurationMs : null,
    llmResponseLatencyMs: typeof value.llmResponseLatencyMs === "number" ? value.llmResponseLatencyMs : null,
    llmDurationMs: typeof value.llmDurationMs === "number" ? value.llmDurationMs : null,
    ttsResponseLatencyMs: typeof value.ttsResponseLatencyMs === "number" ? value.ttsResponseLatencyMs : null,
    ttsDurationMs: typeof value.ttsDurationMs === "number" ? value.ttsDurationMs : null,
    speechEndToLlmFirstTokenMs:
      typeof value.speechEndToLlmFirstTokenMs === "number" ? value.speechEndToLlmFirstTokenMs : null,
    speechEndToTtsFirstChunkMs:
      typeof value.speechEndToTtsFirstChunkMs === "number" ? value.speechEndToTtsFirstChunkMs : null,
    timestamp: typeof value.timestamp === "string" ? value.timestamp : null,
  };
}

/** 写入会话列表到 localStorage，保存前清理临时播放状态。 */
function persistConversations(conversations: ConversationRecord[]) {
  try {
    window.localStorage.setItem(
      CONVERSATION_STORAGE_KEY,
      JSON.stringify(
        conversations.map((conversation) => ({
          ...conversation,
          active: false,
          messages: sanitizeMessagesForStorage(conversation.messages),
        })),
      ),
    );
  } catch {
    // localStorage 可能被隐私模式或浏览器策略禁用，失败时保留当前内存态即可。
  }
}

/** 记录当前选中的会话，刷新页面后继续展示同一条本地记录。 */
function persistActiveConversationId(sessionId: string) {
  try {
    window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, sessionId);
  } catch {
    // localStorage 不可写不影响当前页面继续联调。
  }
}

/** 保存消息时去掉只属于当前播放过程的临时状态。 */
function sanitizeMessagesForStorage(messages: ChatMessage[]) {
  return messages.map((message) => ({
    ...message,
    streaming: false,
    speaking: false,
  }));
}

/** 根据消息内容生成左侧会话摘要，优先显示最近一条用户或助手消息。 */
function buildConversationPreview(messages: ChatMessage[], fallback: string) {
  const latest = messages
    .slice()
    .reverse()
    .find((message) => message.role !== "system" && message.content.trim());
  return latest ? latest.content.trim().slice(0, 48) : fallback;
}

/** 将会话更新时间格式化为短文案。 */
function formatConversationTime(updatedAtMs: number) {
  const diffMs = Date.now() - updatedAtMs;
  if (diffMs < 60_000) {
    return "刚刚";
  }
  if (diffMs < 3_600_000) {
    return `${Math.floor(diffMs / 60_000)} 分钟前`;
  }
  if (diffMs < 86_400_000) {
    return `${Math.floor(diffMs / 3_600_000)} 小时前`;
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(updatedAtMs));
}

/** 格式化指标更新时间。 */
function formatMetricsTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

/** 从 payload 中读取字符串字段。 */
function readPayloadText(event: AgentEventEnvelope, field: string) {
  const value = event.payload?.[field];
  return typeof value === "string" ? value : "";
}

/** 从 payload 中读取数字字段，不存在时使用默认值。 */
function readPayloadNumber(event: AgentEventEnvelope, field: string, defaultValue: number) {
  const value = event.payload?.[field];
  return typeof value === "number" ? value : defaultValue;
}

/** 从 payload 中读取可选数字字段。 */
function readPayloadOptionalNumber(event: AgentEventEnvelope, field: string) {
  const value = event.payload?.[field];
  return typeof value === "number" ? value : null;
}

/** 将 turn_metrics 事件转换为当前会话可展示的指标快照。 */
function buildTurnMetricsView(event: AgentEventEnvelope): TurnMetricsView | null {
  const stage = readPayloadText(event, "stage");
  if (!stage) {
    return null;
  }
  return {
    turnId: event.turnId ?? null,
    stage,
    source: readPayloadText(event, "source") || "unknown",
    asrResponseLatencyMs: readPayloadOptionalNumber(event, "asrResponseLatencyMs"),
    asrDurationMs: readPayloadOptionalNumber(event, "asrDurationMs"),
    llmResponseLatencyMs: readPayloadOptionalNumber(event, "llmResponseLatencyMs"),
    llmDurationMs: readPayloadOptionalNumber(event, "llmDurationMs"),
    ttsResponseLatencyMs: readPayloadOptionalNumber(event, "ttsResponseLatencyMs"),
    ttsDurationMs: readPayloadOptionalNumber(event, "ttsDurationMs"),
    speechEndToLlmFirstTokenMs: readPayloadOptionalNumber(event, "speechEndToLlmFirstTokenMs"),
    speechEndToTtsFirstChunkMs: readPayloadOptionalNumber(event, "speechEndToTtsFirstChunkMs"),
    timestamp: typeof event.timestamp === "string" ? event.timestamp : null,
  };
}

/** 把 turn_metrics 转换为联调时易读的一行摘要。 */
function formatTurnMetricsSummary(event: AgentEventEnvelope) {
  const source = readPayloadText(event, "source") || "unknown";
  const segments = [
    formatMetricSegment("ASR", readPayloadOptionalNumber(event, "asrResponseLatencyMs"), readPayloadOptionalNumber(event, "asrDurationMs")),
    formatMetricSegment("LLM", readPayloadOptionalNumber(event, "llmResponseLatencyMs"), readPayloadOptionalNumber(event, "llmDurationMs")),
    formatMetricSegment("TTS", readPayloadOptionalNumber(event, "ttsResponseLatencyMs"), readPayloadOptionalNumber(event, "ttsDurationMs")),
  ].filter((segment): segment is string => Boolean(segment));
  const speechToLlm = readPayloadOptionalNumber(event, "speechEndToLlmFirstTokenMs");
  const speechToTts = readPayloadOptionalNumber(event, "speechEndToTtsFirstChunkMs");
  if (segments.length === 0 && speechToLlm == null && speechToTts == null) {
    return "";
  }
  const extras = [
    speechToLlm == null ? null : `说完话到 LLM 首字 ${speechToLlm}ms`,
    speechToTts == null ? null : `说完话到 TTS 首包 ${speechToTts}ms`,
  ].filter((segment): segment is string => Boolean(segment));
  return `本轮指标（${source}）：${[...segments, ...extras].join("，")}`;
}

/** 把单个阶段的响应耗时和总耗时格式化成简短文案。 */
function formatMetricSegment(name: string, responseLatencyMs: number | null, durationMs: number | null) {
  if (responseLatencyMs == null && durationMs == null) {
    return null;
  }
  const parts = [
    responseLatencyMs == null ? null : `响应 ${responseLatencyMs}ms`,
    durationMs == null ? null : `耗时 ${durationMs}ms`,
  ].filter((segment): segment is string => Boolean(segment));
  return `${name} ${parts.join(" / ")}`;
}

/** 指标面板属性。 */
interface TurnMetricsPanelProps {
  /** 当前会话最近一次完成轮次的指标。 */
  metrics: TurnMetricsView | null;
}

/** 固定展示当前会话最近一次有效轮次的耗时指标。 */
function TurnMetricsPanel({ metrics }: TurnMetricsPanelProps) {
  const cards = [
    {
      title: "ASR",
      responseLabel: "响应",
      responseValue: metrics?.asrResponseLatencyMs ?? null,
      durationLabel: "耗时",
      durationValue: metrics?.asrDurationMs ?? null,
    },
    {
      title: "LLM",
      responseLabel: "首字",
      responseValue: metrics?.llmResponseLatencyMs ?? null,
      durationLabel: "耗时",
      durationValue: metrics?.llmDurationMs ?? null,
    },
    {
      title: "TTS",
      responseLabel: "首包",
      responseValue: metrics?.ttsResponseLatencyMs ?? null,
      durationLabel: "耗时",
      durationValue: metrics?.ttsDurationMs ?? null,
    },
    {
      title: "说完话后",
      responseLabel: "到 LLM 首字",
      responseValue: metrics?.speechEndToLlmFirstTokenMs ?? null,
      durationLabel: "到 TTS 首包",
      durationValue: metrics?.speechEndToTtsFirstChunkMs ?? null,
    },
  ];

  return (
    <section className="rounded-[1.6rem] border border-primary/12 bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.14),transparent_38%),linear-gradient(135deg,hsl(var(--background)),hsl(var(--secondary)/0.45))] px-4 py-4 shadow-[0_18px_42px_hsl(var(--foreground)/0.06)] md:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.22em] text-primary/80">Latency Panel</p>
          <h2 className="mt-1 text-base font-semibold md:text-lg">当前会话指标</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {metrics
              ? `来源 ${metrics.source} · 阶段 ${metrics.stage}${metrics.turnId ? ` · turn ${metrics.turnId}` : ""}`
              : "完成一轮对话后，这里会显示最近一次 turn 的链路时延。"}
          </p>
        </div>
        {metrics?.timestamp ? <p className="text-xs text-muted-foreground">更新时间 {formatMetricsTimestamp(metrics.timestamp)}</p> : null}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <div key={card.title} className="rounded-2xl border border-border/70 bg-background/78 p-4 backdrop-blur-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{card.title}</p>
            <div className="mt-3 space-y-3">
              <MetricsValue label={card.responseLabel} value={card.responseValue} />
              <MetricsValue label={card.durationLabel} value={card.durationValue} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 单个指标值展示块。 */
interface MetricsValueProps {
  /** 指标名。 */
  label: string;
  /** 指标毫秒值。 */
  value: number | null;
}

/** 用更醒目的方式展示一项耗时。 */
function MetricsValue({ label, value }: MetricsValueProps) {
  return (
    <div className="flex items-end justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right text-xl font-semibold tabular-nums tracking-tight">
        {value == null ? <span className="text-base text-muted-foreground">--</span> : `${value}ms`}
      </span>
    </div>
  );
}

/** 将 rtc_state_changed 转换为适合侧栏展示的简短调试文案。 */
function formatRtcStateMessage(state: string, source: string, detail: string) {
  const sourceLabel =
    source === "peer_connection"
      ? "PeerConnection"
      : source === "ice"
        ? "ICE"
        : source === "media"
          ? "媒体面"
          : "RTC 会话";
  if (state === "failed") {
    return `${sourceLabel} 失败${detail ? `：${detail}` : ""}`;
  }
  if (state === "disconnected") {
    return `${sourceLabel} 已断开${detail ? `：${detail}` : ""}`;
  }
  if (state === "closed") {
    return `${sourceLabel} 已关闭${detail ? `：${detail}` : ""}`;
  }
  return `${sourceLabel} 状态：${state}${detail ? `（${detail}）` : ""}`;
}

/** 将 base64 字符串转换为字节数组。 */
function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** 将浏览器 Float32 音频重采样并转换为 PCM16 little-endian。 */
function floatToPcm16(input: Float32Array, inputRate: number, targetRate: number) {
  const ratio = inputRate / targetRate;
  const outputLength = Math.floor(input.length / ratio);
  const buffer = new ArrayBuffer(outputLength * 2);
  const view = new DataView(buffer);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = Math.floor(index * ratio);
    const sample = Math.max(-1, Math.min(1, input[sourceIndex] || 0));
    const pcm = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(index * 2, pcm, true);
  }

  return buffer;
}

/** 结束所有正在流式生成的消息。 */
function markStreamingDone(messages: ChatMessage[]) {
  return messages.map((message) => (message.streaming ? { ...message, streaming: false } : message));
}

