package io.github.kongweiguang.voice.agent.integration.qwen;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.kongweiguang.v1.json.Json;
import io.github.kongweiguang.voice.agent.asr.AsrUpdate;
import io.github.kongweiguang.voice.agent.audio.AudioFormatSpec;
import io.github.kongweiguang.voice.agent.extension.asr.qwen.QwenAsrProperties;
import io.github.kongweiguang.voice.agent.extension.asr.qwen.QwenRealtimeSession;
import io.github.kongweiguang.voice.agent.extension.asr.qwen.QwenRealtimeSessionFactory;
import io.github.kongweiguang.voice.agent.extension.asr.qwen.QwenStreamingAsrAdapter;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 覆盖 Qwen ASR Realtime 适配器对 DashScope 实时会话的编排行为。
 *
 * @author kongweiguang
 */
@Tag("audio")
@Tag("protocol")
@DisplayName("Qwen ASR Realtime 适配器")
class QwenStreamingAsrAdapterTest {
    @Test
    @DisplayName("acceptAudio 时创建实时会话并追加 Base64 PCM")
    void shouldAppendAudioToRealtimeSession() {
        FakeRealtimeSessionFactory factory = new FakeRealtimeSessionFactory();
        QwenStreamingAsrAdapter adapter = newAdapter(factory);

        Optional<AsrUpdate> update = adapter.acceptAudio("turn-1", "abc".getBytes(StandardCharsets.UTF_8));

        assertThat(update).isEmpty();
        assertThat(factory.session.connected).isTrue();
        assertThat(factory.session.appendedAudio.get()).isEqualTo("YWJj");
    }

    @Test
    @DisplayName("收到 delta 事件后返回 ASR partial")
    void shouldReturnPartialFromRealtimeDeltaEvent() {
        FakeRealtimeSessionFactory factory = new FakeRealtimeSessionFactory();
        QwenStreamingAsrAdapter adapter = newAdapter(factory);
        adapter.acceptAudio("turn-1", new byte[] {1});

        factory.session.emit("""
                {"type":"response.audio_transcript.delta","delta":"你好"}
                """);
        Optional<AsrUpdate> update = adapter.acceptAudio("turn-1", new byte[] {2});

        assertThat(update).isPresent();
        assertThat(update.get().turnId()).isEqualTo("turn-1");
        assertThat(update.get().transcript()).isEqualTo("你好");
        assertThat(update.get().fin()).isFalse();
    }

    @Test
    @DisplayName("官方 partial 事件会拼接 text 和 stash")
    void shouldMergeTextAndStashFromOfficialPartialEvent() {
        FakeRealtimeSessionFactory factory = new FakeRealtimeSessionFactory();
        QwenStreamingAsrAdapter adapter = newAdapter(factory);
        adapter.acceptAudio("turn-1b", new byte[] {1});

        factory.session.emit("""
                {"type":"conversation.item.input_audio_transcription.text","text":"你好，","stash":"世界"}
                """);
        Optional<AsrUpdate> update = adapter.acceptAudio("turn-1b", new byte[] {2});

        assertThat(update).isPresent();
        assertThat(update.get().transcript()).isEqualTo("你好，世界");
        assertThat(update.get().fin()).isFalse();
    }

    @Test
    @DisplayName("commit 时手动提交并等待 completed 最终转写")
    void shouldCommitAndWaitFinalTranscript() {
        FakeRealtimeSessionFactory factory = new FakeRealtimeSessionFactory();
        QwenStreamingAsrAdapter adapter = newAdapter(factory);
        adapter.acceptAudio("turn-2", new byte[] {1, 2});
        factory.session.onEnd = () -> factory.session.emit("""
                {"type":"response.audio_transcript.completed","transcript":"你好，世界"}
                """);

        AsrUpdate update = adapter.commitTurn("turn-2");

        assertThat(factory.session.committed).isTrue();
        assertThat(factory.session.ended).isTrue();
        assertThat(factory.session.closed).isTrue();
        assertThat(update.turnId()).isEqualTo("turn-2");
        assertThat(update.transcript()).isEqualTo("你好，世界");
        assertThat(update.fin()).isTrue();
    }

    @Test
    @DisplayName("Qwen API Key 缺失时直接失败")
    void shouldFailWhenApiKeyMissing() {
        QwenStreamingAsrAdapter adapter = new QwenStreamingAsrAdapter(
                AudioFormatSpec.DEFAULT, properties("", false), new FakeRealtimeSessionFactory());

        assertThatThrownBy(() -> adapter.acceptAudio("turn-3", new byte[1]))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Qwen ASR API Key 未配置");
    }

    @Test
    @DisplayName("服务端 VAD 模式下不调用 commit")
    void shouldNotCommitWhenServerVadEnabled() {
        FakeRealtimeSessionFactory factory = new FakeRealtimeSessionFactory();
        QwenStreamingAsrAdapter adapter = new QwenStreamingAsrAdapter(
                AudioFormatSpec.DEFAULT, properties("test-key", true), factory);
        adapter.acceptAudio("turn-4", new byte[] {1});
        factory.session.onEnd = () -> factory.session.emit("""
                {"type":"response.done","response":{"output":[{"content":[{"text":"服务端断句"}]}]}}
                """);

        AsrUpdate update = adapter.commitTurn("turn-4");

        assertThat(factory.session.committed).isFalse();
        assertThat(factory.session.ended).isTrue();
        assertThat(update.transcript()).isEqualTo("服务端断句");
    }

    @Test
    @DisplayName("上游会话已 finished 时 commit 直接复用最终稿而不重复结束会话")
    void shouldReuseTranscriptWhenSessionAlreadyFinished() {
        FakeRealtimeSessionFactory factory = new FakeRealtimeSessionFactory();
        QwenStreamingAsrAdapter adapter = newAdapter(factory);
        adapter.acceptAudio("turn-5", new byte[] {1});
        factory.session.emit("""
                {"type":"response.audio_transcript.completed","transcript":"已完成"}
                """);
        factory.session.emit("""
                {"type":"session.finished"}
                """);

        AsrUpdate update = adapter.commitTurn("turn-5");

        assertThat(factory.session.committed).isFalse();
        assertThat(factory.session.ended).isFalse();
        assertThat(update.transcript()).isEqualTo("已完成");
    }

    @Test
    @DisplayName("session finished 后收到正常关闭帧时仍返回最终转写")
    void shouldIgnoreNormalConnectionClosedAfterFinished() {
        FakeRealtimeSessionFactory factory = new FakeRealtimeSessionFactory();
        QwenStreamingAsrAdapter adapter = newAdapter(factory);
        adapter.acceptAudio("turn-6", new byte[] {1});
        factory.session.onEnd = () -> {
            factory.session.emit("""
                    {"type":"response.audio_transcript.completed","transcript":"停止说话后的最终稿"}
                    """);
            factory.session.emit("""
                    {"type":"session.finished"}
                    """);
            factory.session.emit("""
                    {"type":"connection.closed","code":1000,"reason":"bye"}
                    """);
        };

        AsrUpdate update = adapter.commitTurn("turn-6");

        assertThat(update.transcript()).isEqualTo("停止说话后的最终稿");
        assertThat(update.fin()).isTrue();
    }

    @Test
    @DisplayName("正常关闭帧不会覆盖已经拿到的最终转写")
    void shouldNotTreatNormalConnectionClosedAsFailure() {
        FakeRealtimeSessionFactory factory = new FakeRealtimeSessionFactory();
        QwenStreamingAsrAdapter adapter = newAdapter(factory);
        adapter.acceptAudio("turn-7", new byte[] {1});
        factory.session.onEnd = () -> {
            factory.session.emit("""
                    {"type":"response.done","response":{"output":[{"content":[{"text":"最终答案文本"}]}]}}
                    """);
            factory.session.emit("""
                    {"type":"connection.closed","code":1000,"reason":"bye"}
                    """);
        };

        AsrUpdate update = adapter.commitTurn("turn-7");

        assertThat(update.transcript()).isEqualTo("最终答案文本");
        assertThat(update.fin()).isTrue();
    }

    @Test
    @DisplayName("清理阶段 close 已关闭会话失败时不覆盖最终转写")
    void shouldIgnoreCloseFailureAfterFinalTranscript() {
        FakeRealtimeSessionFactory factory = new FakeRealtimeSessionFactory();
        QwenStreamingAsrAdapter adapter = newAdapter(factory);
        adapter.acceptAudio("turn-7b", new byte[] {1});
        factory.session.closeFailure = new RuntimeException("conversation is already closed!");
        factory.session.onEnd = () -> factory.session.emit("""
                {"type":"conversation.item.input_audio_transcription.completed","text":"已经识别成功"}
                """);

        AsrUpdate update = adapter.commitTurn("turn-7b");

        assertThat(update.transcript()).isEqualTo("已经识别成功");
        assertThat(update.fin()).isTrue();
        assertThat(factory.session.closed).isTrue();
    }

    @Test
    @DisplayName("completed 为空时会用最近 partial 兜底")
    void shouldFallbackToLatestPartialWhenCompletedTranscriptIsEmpty() {
        FakeRealtimeSessionFactory factory = new FakeRealtimeSessionFactory();
        QwenStreamingAsrAdapter adapter = newAdapter(factory);
        adapter.acceptAudio("turn-7c", new byte[] {1});
        factory.session.emit("""
                {"type":"conversation.item.input_audio_transcription.text","text":"","stash":"短句内容"}
                """);
        factory.session.onEnd = () -> factory.session.emit("""
                {"type":"conversation.item.input_audio_transcription.completed","text":""}
                """);

        AsrUpdate update = adapter.commitTurn("turn-7c");

        assertThat(update.transcript()).isEqualTo("短句内容");
        assertThat(update.fin()).isTrue();
    }

    @Test
    @DisplayName("session finished 本身不会被当作最终转写")
    void shouldNotTreatSessionFinishedAsTranscriptCompleted() {
        FakeRealtimeSessionFactory factory = new FakeRealtimeSessionFactory();
        QwenStreamingAsrAdapter adapter = newAdapter(factory);
        adapter.acceptAudio("turn-8", new byte[] {1});
        factory.session.onEnd = () -> factory.session.emit("""
                {"type":"session.finished"}
                """);

        assertThatThrownBy(() -> adapter.commitTurn("turn-8"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("空转写结果");
    }

    @Test
    @DisplayName("上一轮迟到的关闭事件不会提前结束下一轮")
    void shouldIgnoreLateCloseEventFromPreviousTurn() {
        FakeRealtimeSessionFactory factory = new FakeRealtimeSessionFactory();
        QwenStreamingAsrAdapter adapter = newAdapter(factory);
        adapter.acceptAudio("turn-9", new byte[] {1});
        FakeRealtimeSession firstSession = factory.session;
        firstSession.onEnd = () -> firstSession.emit("""
                {"type":"conversation.item.input_audio_transcription.completed","text":"第一轮"}
                """);
        assertThat(adapter.commitTurn("turn-9").transcript()).isEqualTo("第一轮");

        adapter.acceptAudio("turn-10", new byte[] {2});
        FakeRealtimeSession secondSession = factory.session;
        firstSession.emit("""
                {"type":"connection.closed","code":1000,"reason":"late bye"}
                """);
        secondSession.emit("""
                {"type":"conversation.item.input_audio_transcription.text","text":"第二轮"}
                """);

        Optional<AsrUpdate> partial = adapter.acceptAudio("turn-10", new byte[] {3});
        assertThat(partial).isPresent();
        assertThat(partial.orElseThrow().transcript()).isEqualTo("第二轮");
        secondSession.onEnd = () -> secondSession.emit("""
                {"type":"conversation.item.input_audio_transcription.completed","text":"第二轮完成"}
                """);
        assertThat(adapter.commitTurn("turn-10").transcript()).isEqualTo("第二轮完成");
    }

    /**
     * 创建测试适配器。
     */
    private QwenStreamingAsrAdapter newAdapter(FakeRealtimeSessionFactory factory) {
        return new QwenStreamingAsrAdapter(AudioFormatSpec.DEFAULT, properties("test-key", false), factory);
    }

    /**
     * 创建测试配置。
     */
    private QwenAsrProperties properties(String apiKey, boolean enableTurnDetection) {
        return new QwenAsrProperties(
                true, apiKey, "wss://example.test/realtime", "qwen3-asr-flash-realtime",
                "zh", "pcm", enableTurnDetection, "server_vad", 0.0f, 400, 1000);
    }

    /**
     * 测试用实时会话工厂。
     */
    private static final class FakeRealtimeSessionFactory implements QwenRealtimeSessionFactory {
        /**
         * 最近一次创建的测试会话。
         */
        private FakeRealtimeSession session;

        @Override
        public QwenRealtimeSession create(QwenAsrProperties properties, AudioFormatSpec format, Consumer<JsonNode> eventConsumer) {
            session = new FakeRealtimeSession(eventConsumer);
            return session;
        }
    }

    /**
     * 测试用实时会话。
     */
    private static final class FakeRealtimeSession implements QwenRealtimeSession {
        /**
         * 服务端事件消费者。
         */
        private final Consumer<JsonNode> eventConsumer;

        /**
         * 最近一次追加的 Base64 音频。
         */
        private final AtomicReference<String> appendedAudio = new AtomicReference<>();

        /**
         * endSession 时执行的回调。
         */
        private Runnable onEnd;

        /**
         * 是否已经建立连接。
         */
        private boolean connected;

        /**
         * 是否调用了手动提交。
         */
        private boolean committed;

        /**
         * 是否调用了结束会话。
         */
        private boolean ended;

        /**
         * 是否关闭了会话。
         */
        private boolean closed;

        /**
         * 关闭会话时模拟 SDK 抛出的运行时异常。
         */
        private RuntimeException closeFailure;

        /**
         * 创建测试会话。
         */
        private FakeRealtimeSession(Consumer<JsonNode> eventConsumer) {
            this.eventConsumer = eventConsumer;
        }

        @Override
        public void connect() {
            connected = true;
        }

        @Override
        public void appendAudio(String audioBase64) {
            appendedAudio.set(audioBase64);
        }

        @Override
        public void commit() {
            committed = true;
        }

        @Override
        public void endSession() {
            ended = true;
            if (onEnd != null) {
                onEnd.run();
            }
        }

        @Override
        public void close() {
            closed = true;
            if (closeFailure != null) {
                throw closeFailure;
            }
        }

        /**
         * 主动发出服务端事件。
         */
        private void emit(String event) {
            eventConsumer.accept(Json.node(event));
        }
    }
}
