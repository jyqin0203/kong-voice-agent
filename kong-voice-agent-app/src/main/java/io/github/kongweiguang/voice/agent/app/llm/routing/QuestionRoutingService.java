package io.github.kongweiguang.voice.agent.app.llm.routing;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * 使用低成本模型判断题型、题面完整性和语音转写歧义。
 */
@Service
@RequiredArgsConstructor
public class QuestionRoutingService {
    private static final int MAX_HISTORY_TURNS = 8;
    private static final int MAX_MESSAGE_CHARS = 2_000;
    private static final Pattern EXPLICIT_AMBIGUITY_PATTERN = Pattern.compile(
            "念不准|说不准|听不清|识别错|转写错|可能有误|公式|符号|代码"
    );
    private static final Pattern SPOKEN_SYMBOL_PATTERN = Pattern.compile(
            "平方|立方|次方|根号|下标|上标|大于等于|小于等于|不等于|除以|取模|左括号|右括号"
    );

    private static final String ROUTER_PROMPT = """
            你是实时语音做题系统的内部路由器，只负责分类，不负责解题。
            输入是同一会话最近若干条用户语音转写，最后一条是当前输入。
            请判断：
            1. questionType：CHOICE、PROGRAMMING 或 OTHER。
            2. complete：题干、必要条件、选项或输入输出要求是否已经完整到足以继续处理。
            3. ambiguity：LOW、MEDIUM 或 HIGH。公式、数学符号、变量名、代码、同音字或断句存在多种合理解释时提高等级。
            选择题题面清楚、选项完整且无需复杂推导时使用 LOW；需要结合上下文脑补关键符号或代码时使用 MEDIUM 或 HIGH。
            编程题在用户确认思路、要求给代码或要求下一段时仍归类为 PROGRAMMING。
            只返回 JSON 对象，不要 Markdown，不要解题。格式：
            {"questionType":"CHOICE","complete":true,"ambiguity":"LOW","reason":"简短依据"}
            """;

    private final ObjectMapper objectMapper;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
    private final ConcurrentHashMap<String, ArrayDeque<String>> userHistory = new ConcurrentHashMap<>();

    @Value("${ai.model.api-key:xxx}")
    private String apiKey;

    @Value("${ai.model.base-url:https://dashscope.aliyuncs.com/compatible-mode/v1}")
    private String baseUrl;

    @Value("${ai.model.router-model-name:qwen3.8-flash}")
    private String routerModelName;

    @Value("${ai.model.router-timeout-ms:30000}")
    private long timeoutMs;

    /**
     * 在弹性线程池中调用路由模型，避免阻塞语音流水线线程。
     */
    public Mono<QuestionRoute> route(String sessionId, String latestMessage) {
        List<String> context = rememberAndSnapshot(sessionId, latestMessage);
        return Mono.fromCallable(() -> requestRoute(context))
                .subscribeOn(Schedulers.boundedElastic());
    }

    private QuestionRoute requestRoute(List<String> context) throws Exception {
        Map<String, Object> body = Map.of(
                "model", routerModelName,
                "messages", List.of(
                        Map.of("role", "system", "content", ROUTER_PROMPT),
                        Map.of("role", "user", "content", formatContext(context))
                ),
                "enable_thinking", false,
                "temperature", 0,
                "max_tokens", 200,
                "response_format", Map.of("type", "json_object")
        );
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(chatCompletionsUrl()))
                .timeout(Duration.ofMillis(timeoutMs))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)))
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IllegalStateException("路由模型调用失败，HTTP " + response.statusCode());
        }
        JsonNode root = objectMapper.readTree(response.body());
        String content = root.path("choices").path(0).path("message").path("content").asText();
        if (content.isBlank()) {
            throw new IllegalStateException("路由模型返回空内容");
        }
        return applyLocalGuardrails(parseRoute(content), context);
    }

    /**
     * 对路由模型容易低估的口述公式和显式转写异常增加确定性兜底。
     */
    QuestionRoute applyLocalGuardrails(QuestionRoute route, List<String> context) {
        if (!route.complete() || route.questionType() != QuestionRoute.QuestionType.CHOICE) {
            return route;
        }
        String joined = String.join("\n", context);
        if (EXPLICIT_AMBIGUITY_PATTERN.matcher(joined).find()) {
            return new QuestionRoute(route.questionType(), true, QuestionRoute.Ambiguity.HIGH,
                    "检测到公式、符号、代码或显式转写异常线索");
        }
        if (route.ambiguity() == QuestionRoute.Ambiguity.LOW
                && SPOKEN_SYMBOL_PATTERN.matcher(joined).find()) {
            return new QuestionRoute(route.questionType(), true, QuestionRoute.Ambiguity.MEDIUM,
                    "检测到需要还原的口述数学符号");
        }
        return route;
    }

    QuestionRoute parseRoute(String content) throws Exception {
        String normalized = stripMarkdownFence(content);
        JsonNode node = objectMapper.readTree(normalized);
        QuestionRoute.QuestionType questionType = enumValue(
                QuestionRoute.QuestionType.class,
                node.path("questionType").asText(),
                QuestionRoute.QuestionType.OTHER
        );
        QuestionRoute.Ambiguity ambiguity = enumValue(
                QuestionRoute.Ambiguity.class,
                node.path("ambiguity").asText(),
                QuestionRoute.Ambiguity.HIGH
        );
        return new QuestionRoute(
                questionType,
                node.path("complete").asBoolean(false),
                ambiguity,
                node.path("reason").asText("")
        );
    }

    private List<String> rememberAndSnapshot(String sessionId, String latestMessage) {
        String normalizedSessionId = sessionId == null ? "" : sessionId.trim();
        String normalizedMessage = latestMessage == null ? "" : latestMessage.trim();
        if (normalizedMessage.length() > MAX_MESSAGE_CHARS) {
            normalizedMessage = normalizedMessage.substring(normalizedMessage.length() - MAX_MESSAGE_CHARS);
        }
        ArrayDeque<String> history = userHistory.computeIfAbsent(normalizedSessionId, ignored -> new ArrayDeque<>());
        synchronized (history) {
            history.addLast(normalizedMessage);
            while (history.size() > MAX_HISTORY_TURNS) {
                history.removeFirst();
            }
            return new ArrayList<>(history);
        }
    }

    private String formatContext(List<String> context) {
        StringBuilder builder = new StringBuilder("最近用户输入（按时间顺序）：\n");
        for (int index = 0; index < context.size(); index++) {
            builder.append(index + 1).append(". ").append(context.get(index)).append('\n');
        }
        return builder.toString();
    }

    private String chatCompletionsUrl() {
        return baseUrl.endsWith("/") ? baseUrl + "chat/completions" : baseUrl + "/chat/completions";
    }

    private String stripMarkdownFence(String content) {
        String normalized = content.trim();
        if (!normalized.startsWith("```")) {
            return normalized;
        }
        int firstLineEnd = normalized.indexOf('\n');
        int lastFence = normalized.lastIndexOf("```");
        if (firstLineEnd < 0 || lastFence <= firstLineEnd) {
            return normalized;
        }
        return normalized.substring(firstLineEnd + 1, lastFence).trim();
    }

    private <T extends Enum<T>> T enumValue(Class<T> type, String value, T fallback) {
        try {
            return Enum.valueOf(type, value.trim().toUpperCase(Locale.ROOT));
        } catch (RuntimeException ignored) {
            return fallback;
        }
    }
}
