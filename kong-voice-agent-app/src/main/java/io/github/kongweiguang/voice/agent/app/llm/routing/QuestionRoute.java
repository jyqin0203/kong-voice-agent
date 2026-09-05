package io.github.kongweiguang.voice.agent.app.llm.routing;

/**
 * 一轮题目输入的模型路由结果。
 *
 * @param questionType 题型
 * @param complete     当前题面是否足以作答
 * @param ambiguity    语音转写歧义程度
 * @param reason       供服务端调试的简短路由依据
 */
public record QuestionRoute(QuestionType questionType,
                            boolean complete,
                            Ambiguity ambiguity,
                            String reason) {

    /**
     * 路由异常时优先使用最强模型，避免因分类失败降低答案质量。
     */
    public static QuestionRoute reasoningFallback(String reason) {
        return new QuestionRoute(QuestionType.OTHER, true, Ambiguity.HIGH, reason);
    }

    /**
     * 只有完整且复杂或存在明显歧义的题目才启用最强推理模型。
     */
    public boolean requiresStrongReasoning() {
        if (!complete) {
            return false;
        }
        return questionType == QuestionType.PROGRAMMING || ambiguity != Ambiguity.LOW;
    }

    public enum QuestionType {
        CHOICE,
        PROGRAMMING,
        OTHER
    }

    public enum Ambiguity {
        LOW,
        MEDIUM,
        HIGH
    }
}
