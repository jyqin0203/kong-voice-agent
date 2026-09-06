package io.github.kongweiguang.voice.agent.app.service;

import io.agentscope.core.ReActAgent;
import io.agentscope.core.agent.EventType;
import io.agentscope.core.agent.StreamOptions;
import io.agentscope.core.formatter.openai.OpenAIChatFormatter;
import io.agentscope.core.memory.InMemoryMemory;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.MsgRole;
import io.agentscope.core.message.TextBlock;
import io.agentscope.core.model.GenerateOptions;
import io.agentscope.core.model.OpenAIChatModel;
import io.agentscope.core.model.transport.OkHttpTransport;
import io.agentscope.core.session.InMemorySession;
import io.agentscope.core.session.Session;
import io.github.kongweiguang.v1.json.Json;
import io.github.kongweiguang.voice.agent.app.dto.ChatEvent;
import io.github.kongweiguang.voice.agent.app.llm.routing.QuestionRoute;
import io.github.kongweiguang.voice.agent.app.llm.routing.QuestionRoutingService;
import io.github.kongweiguang.voice.agent.app.util.MsgUtils;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.util.concurrent.ConcurrentHashMap;

/**
 * 管理应用侧 Agent 和对话会话。
 *
 * <p>这里使用 AgentScope 的 InMemorySession 保存 Agent 状态。每次请求创建新的 Agent 实例，
 * 再从 session 恢复历史；上层 voice pipeline 通过 turnId 控制旧输出失效。</p>
 *
 * @author kongweiguang
 */
@Service
@Slf4j
@RequiredArgsConstructor
public class AgentService {
    private final QuestionRoutingService questionRoutingService;

    /**
     * OpenAI 兼容模型 API Key。
     */
    @Value("${ai.model.api-key:xxx}")
    private String apiKey;

    /**
     * OpenAI 兼容模型服务地址。
     */
    @Value("${ai.model.base-url:http://124.74.245.74:34033/v1}")
    private String baseUrl;

    /**
     * OpenAI 兼容模型名称。
     */
    @Value("${ai.model.choice-model-name:qwen3.7-plus}")
    private String choiceModelName;

    /**
     * 复杂题与编程题使用的强推理模型。
     */
    @Value("${ai.model.reasoning-model-name:qwen3.8-max}")
    private String reasoningModelName;

    /**
     * AgentScope 会话存储，用于在同一个 voice session 内保留对话记忆。
     */
    private final Session session = new InMemorySession();

    /**
     * 正在运行的 Agent 缓存，key 为 sessionId，请求结束后清理。
     */
    private final ConcurrentHashMap<String, ReActAgent> runningAgents = new ConcurrentHashMap<>();


    /**
     * 创建新的 Agent 实例，并按 voice sessionId 恢复历史状态。
     */
    private ReActAgent createAgent(String sessionId, ModelSelection modelSelection) {
        ReActAgent agent = ReActAgent.builder()
                .name("实时语音做题助手")
                .sysPrompt("""
                        你是一个实时语音做题助手。用户主要会提出选择题和编程题，请结合当前输入和对话上下文自然回答。
                        选择题直接给出答案选项和简短理由。
                        编程题默认使用 Python 3，直接读取标准输入并输出结果，不要定义函数。
                        语音转写可能存在错误，请结合题意作出合理判断；确实无法判断时再向用户询问。
                        """)
                .model(getModel(modelSelection))
                .memory(new InMemoryMemory())
                .build();
        agent.loadIfExists(session, sessionId);
        return agent;
    }

    private OpenAIChatModel getModel(ModelSelection modelSelection) {
        // 使用 OpenAI 兼容模型接口，便于替换本地网关、Ollama 代理或云厂商兼容端点。
        return OpenAIChatModel.builder()
                .apiKey(apiKey)
                .modelName(modelSelection.modelName())
                .baseUrl(baseUrl)
                .httpTransport(OkHttpTransport.builder().build())
                .formatter(new OpenAIChatFormatter())
                .generateOptions(
                        GenerateOptions.builder()
                                .additionalBodyParam("enable_thinking", modelSelection.enableThinking())
                                .build()
                )
                .build();
    }

    /**
     * 处理一条已提交的用户输入，并输出可被 LLM 编排器消费的事件流。
     */
    public Flux<ChatEvent> chat(String sessionId, String message) {
        return questionRoutingService.route(sessionId, message)
                .onErrorResume(error -> {
                    log.warn("题型路由失败，回退强推理模型: sessionId={}, reason={}", sessionId, error.getMessage());
                    return Mono.just(QuestionRoute.reasoningFallback("router_failed"));
                })
                .flatMapMany(route -> chatWithRoute(sessionId, message, route));
    }

    private Flux<ChatEvent> chatWithRoute(String sessionId, String message, QuestionRoute route) {
        ModelSelection modelSelection = selectModel(route);
        log.info("选择答题模型: sessionId={}, questionType={}, complete={}, ambiguity={}, model={}, thinking={}",
                sessionId,
                route.questionType(),
                route.complete(),
                route.ambiguity(),
                modelSelection.modelName(),
                modelSelection.enableThinking());
        ReActAgent agent = createAgent(sessionId, modelSelection);
        runningAgents.put(sessionId, agent);

        // voice pipeline 只在 ASR final 或文本 committed 后调用这里，因此 message 已是本轮最终用户文本。
        Msg userMsg = Msg.builder()
                .name("User")
                .role(MsgRole.USER)
                .content(TextBlock.builder().text(message).build())
                .build();
        StreamOptions streamOptions =
                StreamOptions.builder()
                        .eventTypes(EventType.REASONING, EventType.TOOL_RESULT)
                        .incremental(true)
                        .includeReasoningResult(false)
                        .build();
        return agent.stream(userMsg, streamOptions)
                // AgentScope 的模型事件统一压成 TEXT 事件，后续由 OllamaLlmOrchestrator 转为 LlmChunk。
                .map(event -> ChatEvent.text(MsgUtils.getTextContent(event.getMessage()), true, rawResponse(event)))
                .concatWith(Flux.just(ChatEvent.complete()))
                .doFinally(signal -> {
                    // 流结束后保存 Agent 记忆，再移除运行态，避免长期占用模型上下文对象。
                    runningAgents.remove(sessionId);
                    agent.saveTo(session, sessionId);

                })
                // 下游统一接收 ERROR 和 COMPLETE，避免模型异常让响应流悬挂。
                .onErrorResume(error -> Flux.just(ChatEvent.error(error.getMessage()), ChatEvent.complete()));
    }

    private ModelSelection selectModel(QuestionRoute route) {
        if (route.requiresStrongReasoning()) {
            // 当前 AgentScope 会把百炼 thinking 内容并入正文；关闭显式 thinking，避免内部草稿进入字幕和 TTS。
            return new ModelSelection(reasoningModelName, false);
        }
        return new ModelSelection(choiceModelName, false);
    }

    /**
     * 尽量保留底层模型事件原貌；序列化失败时退回对象字符串，避免影响主回复链路。
     */
    private String rawResponse(Object event) {
        try {
            return Json.str(event);
        } catch (Exception ex) {
            return String.valueOf(event);
        }
    }

    private record ModelSelection(String modelName, boolean enableThinking) {
    }

}
