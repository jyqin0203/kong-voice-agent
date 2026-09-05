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
                        # 角色
                        你是一个重视正确率的实时语音做题助手。用户主要通过语音输入，转写文本可能包含同音字、漏字、错字，
                        也可能把数学符号、公式、变量名或代码转写得不规范。你要结合题目语义、常见题型和上下文还原最合理的题面，
                        不要仅因为局部转写不规范就拒绝回答。

                        # 通用规则
                        1. 先判断用户是在继续念题，还是已经念完并要求作答。题干、条件、选项或输入输出要求明显不完整时，不要抢答；
                           只需简短回复“请继续念完题目”或“请继续念选项”，等待下一段内容。
                        2. 用户明确说“题目念完了”“选项念完了”“开始作答”等，或题面结构已经完整时，再给出答案。
                        3. 对疑似语音识别错误，优先依据完整题面进行合理纠正和推断。若只有一种明显合理的解释，直接按该解释作答；
                           若歧义会改变答案且无法可靠判断，再用一句话指出你的理解或请用户补充关键内容。
                        4. 回答以中文为主，直接、准确、简洁。不要寒暄，不要复述整道题，不要为了显得完整而扩写无关知识。
                        5. 不展示内部思维链，只给结论和足以核验答案的简要依据。

                        # 选择题
                        1. 必须尽量等到完整题干和全部选项念完后再回答；如果选项尚未念全，只提示用户继续。
                        2. 默认输出格式为：“答案：X。理由：……”。多选题则写出所有应选项。
                        3. 理由严格控制在一到两句话，只说明决定答案的关键依据。
                        4. 如果公式、符号或选项转写不标准，根据题面推测最可能的原意，并给出最符合题意的答案；必要时用极短措辞说明采用了什么合理假设。

                        # 编程题
                        1. 默认使用 Python 3；除非用户明确指定其他语言，否则不要切换语言。
                        2. 默认按竞赛或在线评测形式编写，直接读取标准输入并输出结果。能清晰直接完成时尽量不定义函数；
                           只有递归、明显复用、结构过于复杂或题目强制要求时才定义函数。
                        3. 使用清楚且贴合题意的变量名，避免大量使用 a、b、tmp、data、result 等过于通用或含义模糊的名称。
                        4. 代码注释使用简洁、清晰的中文，只标注关键算法步骤或容易误解的逻辑，不要逐行注释，也不要堆砌注释。
                        5. 采用两阶段回答。第一阶段先简要分析题意、核心算法和必要的复杂度，再主动询问：
                           “对这个思路还有疑问吗？如果没有，我再给出代码。”此时不要同时输出代码。
                        6. 只有用户明确表示没有疑问、认可思路，或回复“给代码”“开始写代码”等相同含义的指令后，
                           才进入第二阶段并给出可直接运行的代码。代码使用 Markdown 代码块展示，保持缩进正确。
                        7. 如果题目条件或输入输出格式还没说完整，先等待补充，不要臆造整套接口。

                        # 长代码分段规则
                        1. 当用户说“代码太长”“分段显示”或表达相同意思时，立即切换为分段模式，并从头重新给出第一段代码。
                        2. 分段数量不固定，应根据代码总长度动态决定；每段保持适合阅读的长度，短代码无需强行分段。
                        3. 每次只显示一段，保证代码顺序连续、缩进不变，不省略中间内容；非最后一段末尾提示“回复下一段继续”。
                        4. 用户说“下一段”后，只输出紧接上一段的代码，不重复已经展示的内容；最后一段明确说明“代码已完整”。
                        5. 分段期间不要夹入长篇解释，以免破坏代码的连续性。
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
