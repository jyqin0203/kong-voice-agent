package io.github.kongweiguang.voice.agent.app.llm.routing;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class QuestionRoutingServiceTest {
    private final QuestionRoutingService service = new QuestionRoutingService(new ObjectMapper());

    @Test
    void parsesStructuredRoute() throws Exception {
        QuestionRoute route = service.parseRoute("""
                {"questionType":"CHOICE","complete":true,"ambiguity":"LOW","reason":"选项完整"}
                """);

        assertThat(route.questionType()).isEqualTo(QuestionRoute.QuestionType.CHOICE);
        assertThat(route.complete()).isTrue();
        assertThat(route.ambiguity()).isEqualTo(QuestionRoute.Ambiguity.LOW);
    }

    @Test
    void acceptsMarkdownFenceAndFallsBackForUnknownEnums() throws Exception {
        QuestionRoute route = service.parseRoute("""
                ```json
                {"questionType":"unknown","complete":true,"ambiguity":"unknown","reason":"格式异常"}
                ```
                """);

        assertThat(route.questionType()).isEqualTo(QuestionRoute.QuestionType.OTHER);
        assertThat(route.ambiguity()).isEqualTo(QuestionRoute.Ambiguity.HIGH);
    }

    @Test
    void explicitTranscriptionProblemForcesHighAmbiguity() {
        QuestionRoute clearRoute = new QuestionRoute(
                QuestionRoute.QuestionType.CHOICE,
                true,
                QuestionRoute.Ambiguity.LOW,
                "模型认为题面清楚"
        );

        QuestionRoute guarded = service.applyLocalGuardrails(
                clearRoute,
                List.of("这里的公式符号可能念不准，题目念完了")
        );

        assertThat(guarded.ambiguity()).isEqualTo(QuestionRoute.Ambiguity.HIGH);
        assertThat(guarded.requiresStrongReasoning()).isTrue();
    }

    @Test
    void spokenMathSymbolRaisesLowAmbiguity() {
        QuestionRoute clearRoute = new QuestionRoute(
                QuestionRoute.QuestionType.CHOICE,
                true,
                QuestionRoute.Ambiguity.LOW,
                "模型认为题面清楚"
        );

        QuestionRoute guarded = service.applyLocalGuardrails(
                clearRoute,
                List.of("若爱克斯平方等于四，选择正确答案")
        );

        assertThat(guarded.ambiguity()).isEqualTo(QuestionRoute.Ambiguity.MEDIUM);
        assertThat(guarded.requiresStrongReasoning()).isTrue();
    }
}
