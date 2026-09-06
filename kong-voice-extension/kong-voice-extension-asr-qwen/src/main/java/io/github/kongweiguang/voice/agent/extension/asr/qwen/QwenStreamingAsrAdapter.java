package io.github.kongweiguang.voice.agent.extension.asr.qwen;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.kongweiguang.voice.agent.asr.AsrUpdate;
import io.github.kongweiguang.voice.agent.asr.StreamingAsrAdapter;
import io.github.kongweiguang.voice.agent.audio.AudioFormatSpec;
import lombok.extern.slf4j.Slf4j;
import lombok.RequiredArgsConstructor;

import java.util.ArrayDeque;
import java.util.Base64;
import java.util.Deque;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 基于 Qwen-ASR-Realtime 的会话级 ASR 适配器。
 *
 * @author kongweiguang
 */
@Slf4j
@RequiredArgsConstructor
public class QwenStreamingAsrAdapter implements StreamingAsrAdapter {
    /**
     * 当前会话使用的音频格式，用于配置实时识别输入采样率。
     */
    private final AudioFormatSpec format;

    /**
     * Qwen ASR Realtime 服务配置。
     */
    private final QwenAsrProperties properties;

    /**
     * 实时识别会话工厂。
     */
    private final QwenRealtimeSessionFactory sessionFactory;

    /**
     * 当前 turn 对应的实时识别会话。
     */
    private QwenRealtimeSession session;

    /**
     * 当前实时识别会话绑定的 turnId。
     */
    private String activeTurnId;

    /**
     * 实时连接代次；旧连接迟到的关闭或转写事件不得污染下一轮。
     */
    private long sessionGeneration;

    /**
     * 服务端 partial 事件队列，acceptAudio 返回时按顺序吐给核心流水线。
     */
    private final Deque<AsrUpdate> partialUpdates = new ArrayDeque<>();

    /**
     * 当前 turn 的最终转写文本。
     */
    private final AtomicReference<String> finalTranscript = new AtomicReference<>();

    /**
     * 最近一次可用的转写文本，用于上游正常结束但缺少 completed 事件时兜底。
     */
    private final AtomicReference<String> latestTranscript = new AtomicReference<>();

    /**
     * 当前 turn 的异步失败原因。
     */
    private final AtomicReference<Throwable> failure = new AtomicReference<>();

    /**
     * 当前 turn 的实时会话是否已经收到服务端 finished/closed 信号。
     */
    private boolean sessionFinished;

    /**
     * 等待最终转写或会话结束的同步门闩。
     */
    private CountDownLatch finished = new CountDownLatch(1);

    /**
     * 保护实时会话生命周期和事件队列。
     */
    private final Object monitor = new Object();

    /**
     * 创建生产默认适配器。
     */
    public QwenStreamingAsrAdapter(AudioFormatSpec format, QwenAsrProperties properties) {
        this(format, properties, new DashScopeQwenRealtimeSessionFactory());
    }

    /**
     * 接收音频并立即追加到 Qwen Realtime 输入缓冲区。
     */
    @Override
    public Optional<AsrUpdate> acceptAudio(String turnId, byte[] pcm) {
        requireApiKey();
        synchronized (monitor) {
            ensureSession(turnId);
            if (sessionFinished) {
                // 上游已明确结束当前 turn 时不再继续追加音频，等待流水线随后 commit 取回最终稿。
                log.debug("Ignore audio for finished Qwen ASR session, turnId={}", turnId);
                return Optional.ofNullable(partialUpdates.pollFirst());
            }
            log.debug("Append audio to Qwen ASR: turnId={}, bytes={}", turnId, pcm.length);
            session.appendAudio(Base64.getEncoder().encodeToString(pcm));
            return Optional.ofNullable(partialUpdates.pollFirst());
        }
    }

    /**
     * 提交当前 turn，并等待 Qwen Realtime 返回最终转写。
     */
    @Override
    public AsrUpdate commitTurn(String turnId) {
        requireApiKey();
        log.info("Commit Qwen ASR turn: turnId={}", turnId);
        QwenRealtimeSession sessionToCommit;
        CountDownLatch latchToWait;
        synchronized (monitor) {
            if (session == null || activeTurnId == null || !activeTurnId.equals(turnId)) {
                throw new IllegalStateException("当前 turn 没有可提交给 Qwen ASR Realtime 的音频");
            }
            sessionToCommit = session;
            latchToWait = finished;
            if (sessionFinished) {
                log.info("Qwen ASR session already finished before commit, reuse final transcript directly, turnId={}", turnId);
                sessionToCommit = null;
            }
        }
        try {
            if (sessionToCommit != null && !Boolean.TRUE.equals(properties.enableTurnDetection())) {
                log.info("Send commit() to Qwen ASR session: turnId={}", turnId);
                sessionToCommit.commit();
            }
            if (sessionToCommit != null) {
                log.info("Send endSession() to Qwen ASR session: turnId={}", turnId);
                sessionToCommit.endSession();
            }
            boolean completed = sessionFinished || latchToWait.await(properties.timeoutMs(), TimeUnit.MILLISECONDS);
            if (!completed) {
                throw new IllegalStateException("Qwen ASR Realtime 等待最终转写超时");
            }
            if (failure.get() != null) {
                throw new IllegalStateException("Qwen ASR Realtime 识别失败", failure.get());
            }
            String transcript = finalTranscript.get();
            if (transcript == null || transcript.isBlank()) {
                throw new IllegalStateException("Qwen ASR Realtime 返回了空转写结果");
            }
            log.info("Qwen ASR commit finished: turnId={}, transcript={}", turnId, transcript.strip());
            return AsrUpdate.finalUpdate(turnId, transcript.strip());
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Qwen ASR Realtime 等待最终转写被中断", ex);
        } finally {
            closeCurrentSession();
        }
    }

    /**
     * 关闭 ASR 时释放当前实时连接。
     */
    @Override
    public void close() {
        closeCurrentSession();
    }

    /**
     * 确保当前 turn 已经建立实时识别连接。
     */
    private void ensureSession(String turnId) {
        if (session != null && turnId.equals(activeTurnId)) {
            return;
        }
        closeCurrentSession();
        activeTurnId = turnId;
        finalTranscript.set(null);
        latestTranscript.set(null);
        failure.set(null);
        partialUpdates.clear();
        finished = new CountDownLatch(1);
        sessionFinished = false;
        long generation = ++sessionGeneration;
        String sessionTurnId = turnId;
        session = sessionFactory.create(properties, format, event -> handleEvent(generation, sessionTurnId, event));
        log.info("Create Qwen ASR realtime session: turnId={}, sampleRate={}, language={}, turnDetectionEnabled={}",
                turnId, format.sampleRate(), properties.language(), properties.enableTurnDetection());
        session.connect();
    }

    /**
     * 解析 Qwen Realtime 服务端事件，转换为项目 ASR partial / final 状态。
     */
    private void handleEvent(long generation, String sessionTurnId, JsonNode event) {
        synchronized (monitor) {
            if (generation != sessionGeneration || !sessionTurnId.equals(activeTurnId)) {
                log.debug("Ignore stale Qwen ASR event: eventTurnId={}, activeTurnId={}, eventType={}",
                        sessionTurnId, activeTurnId, event.path("type").asText(""));
                return;
            }
            String type = event.path("type").asText("");
            log.info("Receive Qwen ASR event: turnId={}, type={}", activeTurnId, type);
            if (isPartialTranscriptEvent(type)) {
                enqueuePartial(extractText(event));
                return;
            }
            if (isCompletedTranscriptEvent(type)) {
                completeTranscript(extractText(event));
                return;
            }
            if (type.equals("session.finished")) {
                log.info("Qwen ASR session finished by upstream, turnId={}", activeTurnId);
                sessionFinished = true;
                promoteLatestTranscriptIfNecessary("session.finished");
                if (finalTranscript.get() != null && !finalTranscript.get().isBlank()) {
                    finished.countDown();
                }
                return;
            }
            if (type.equals("connection.closed")) {
                handleConnectionClosed(event);
                return;
            }
            if (type.contains("error")) {
                sessionFinished = true;
                log.warn("Qwen ASR session closed with error, turnId={}, event={}", activeTurnId, event);
                failure.compareAndSet(null, new IllegalStateException(event.toString()));
                finished.countDown();
            }
        }
    }

    /**
     * 判断事件是否属于流式局部转写。
     */
    private boolean isPartialTranscriptEvent(String type) {
        return "response.audio_transcript.delta".equals(type)
                || "conversation.item.input_audio_transcription.text".equals(type);
    }

    /**
     * 判断事件是否属于最终转写完成。
     */
    private boolean isCompletedTranscriptEvent(String type) {
        return "response.audio_transcript.completed".equals(type)
                || "conversation.item.input_audio_transcription.completed".equals(type)
                || "response.done".equals(type);
    }

    /**
     * 区分正常关闭和异常关闭，避免上游已经正常收尾后又被关闭帧覆盖成失败。
     */
    private void handleConnectionClosed(JsonNode event) {
        sessionFinished = true;
        int code = event.path("code").asInt(-1);
        if (code == 1000) {
            promoteLatestTranscriptIfNecessary("connection.closed");
            log.info("Qwen ASR session closed normally, turnId={}, event={}", activeTurnId, event);
            finished.countDown();
            return;
        }
        log.warn("Qwen ASR session closed with error, turnId={}, event={}", activeTurnId, event);
        failure.compareAndSet(null, new IllegalStateException(event.toString()));
        finished.countDown();
    }

    /**
     * 记录 partial 文本，空文本不下发，避免前端收到无意义字幕。
     */
    private void enqueuePartial(String text) {
        if (text == null || text.isBlank() || activeTurnId == null) {
            return;
        }
        String normalized = text.strip();
        log.debug("Queue Qwen ASR partial: turnId={}, transcript={}", activeTurnId, normalized);
        latestTranscript.set(normalized);
        partialUpdates.addLast(AsrUpdate.partial(activeTurnId, normalized));
    }

    /**
     * 记录最终转写并唤醒 commitTurn。
     */
    private void completeTranscript(String text) {
        if (text != null && !text.isBlank()) {
            String normalized = text.strip();
            log.info("Capture Qwen ASR completed transcript: turnId={}, transcript={}", activeTurnId, normalized);
            latestTranscript.set(normalized);
            finalTranscript.set(normalized);
            finished.countDown();
            return;
        }
        log.warn("Qwen ASR completed event contains empty transcript, wait for session close or latest partial fallback, turnId={}",
                activeTurnId);
        promoteLatestTranscriptIfNecessary("completed.empty");
        if (finalTranscript.get() != null && !finalTranscript.get().isBlank()) {
            finished.countDown();
        }
    }

    /**
     * 上游在正常结束前可能只下发 partial，不下发 completed；此时回退到最近一次转写。
     */
    private void promoteLatestTranscriptIfNecessary(String eventType) {
        if (finalTranscript.get() != null && !finalTranscript.get().isBlank()) {
            return;
        }
        String latest = latestTranscript.get();
        if (latest != null && !latest.isBlank()) {
            log.warn("Qwen ASR missing completed transcript, fallback to latest partial, turnId={}, eventType={}, transcript={}",
                    activeTurnId, eventType, latest);
            finalTranscript.set(latest);
        }
    }

    /**
     * 从不同服务端事件字段中尽量提取文本，兼容 delta、transcript 和 content 形态。
     */
    private String extractText(JsonNode event) {
        String transcriptWithStash = concatText(event.path("text"), event.path("stash"));
        if (!transcriptWithStash.isBlank()) {
            return transcriptWithStash;
        }
        String direct = firstText(event.path("delta"), event.path("transcript"), event.path("text"), event.path("content"));
        if (!direct.isBlank()) {
            return direct;
        }
        StringBuilder builder = new StringBuilder();
        appendText(builder, event.path("response"));
        appendText(builder, event.path("item"));
        appendText(builder, event.path("output"));
        return builder.toString();
    }

    /**
     * 兼容 Qwen Realtime 把 partial 拆成 text + stash 的事件结构。
     */
    private String concatText(JsonNode first, JsonNode second) {
        StringBuilder builder = new StringBuilder();
        if (first != null && first.isTextual() && !first.asText().isBlank()) {
            builder.append(first.asText());
        }
        if (second != null && second.isTextual() && !second.asText().isBlank()) {
            builder.append(second.asText());
        }
        return builder.toString();
    }

    /**
     * 从候选节点中返回第一个字符串文本。
     */
    private String firstText(JsonNode... nodes) {
        for (JsonNode node : nodes) {
            if (node != null && node.isTextual() && !node.asText().isBlank()) {
                return node.asText();
            }
        }
        return "";
    }

    /**
     * 递归扫描常见文本字段，用于兼容 SDK 事件结构变化。
     */
    private void appendText(StringBuilder builder, JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return;
        }
        if (node.isTextual()) {
            builder.append(node.asText());
            return;
        }
        if (node.isArray()) {
            for (JsonNode item : node) {
                appendText(builder, item);
            }
            return;
        }
        appendText(builder, node.path("transcript"));
        appendText(builder, node.path("text"));
        appendText(builder, node.path("content"));
        appendText(builder, node.path("output"));
    }

    /**
     * 关闭当前实时会话并清理状态。
     */
    private void closeCurrentSession() {
        synchronized (monitor) {
            // 先让当前回调失效；SDK close 可能异步补发 connection.closed。
            sessionGeneration++;
            if (session != null) {
                try {
                    session.close();
                } catch (RuntimeException ex) {
                    // close 只做资源回收，不能覆盖已经成功拿到的最终转写。
                    if (isAlreadyClosed(ex)) {
                        log.info("Ignore already closed Qwen ASR session during cleanup, turnId={}", activeTurnId);
                    } else {
                        log.warn("Ignore Qwen ASR close failure during cleanup, turnId={}", activeTurnId, ex);
                    }
                }
            }
            session = null;
            activeTurnId = null;
            partialUpdates.clear();
            sessionFinished = false;
        }
    }

    /**
     * DashScope SDK 在服务端已正常关闭后重复 close 时会抛出该异常，业务上按幂等关闭处理。
     */
    private boolean isAlreadyClosed(RuntimeException ex) {
        return ex.getMessage() != null && ex.getMessage().contains("conversation is already closed");
    }

    /**
     * 校验 API Key，避免发出不可鉴权请求。
     */
    private void requireApiKey() {
        if (properties.apiKey() == null || properties.apiKey().isBlank()) {
            throw new IllegalStateException("Qwen ASR API Key 未配置，请设置 KONG_VOICE_AGENT_QWEN_API_KEY 或 DASHSCOPE_API_KEY");
        }
    }
}
