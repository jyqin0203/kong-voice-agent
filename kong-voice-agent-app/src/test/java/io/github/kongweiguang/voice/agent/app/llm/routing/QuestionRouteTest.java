package io.github.kongweiguang.voice.agent.app.llm.routing;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class QuestionRouteTest {

    @Test
    void clearChoiceUsesBalancedModel() {
        QuestionRoute route = new QuestionRoute(
                QuestionRoute.QuestionType.CHOICE,
                true,
                QuestionRoute.Ambiguity.LOW,
                "题面完整"
        );

        assertThat(route.requiresStrongReasoning()).isFalse();
    }

    @Test
    void ambiguousChoiceUsesStrongModel() {
        QuestionRoute route = new QuestionRoute(
                QuestionRoute.QuestionType.CHOICE,
                true,
                QuestionRoute.Ambiguity.MEDIUM,
                "公式转写含糊"
        );

        assertThat(route.requiresStrongReasoning()).isTrue();
    }

    @Test
    void programmingUsesStrongModelOnlyAfterQuestionIsComplete() {
        QuestionRoute incomplete = new QuestionRoute(
                QuestionRoute.QuestionType.PROGRAMMING,
                false,
                QuestionRoute.Ambiguity.HIGH,
                "输入格式尚未念完"
        );
        QuestionRoute complete = new QuestionRoute(
                QuestionRoute.QuestionType.PROGRAMMING,
                true,
                QuestionRoute.Ambiguity.LOW,
                "题面完整"
        );

        assertThat(incomplete.requiresStrongReasoning()).isFalse();
        assertThat(complete.requiresStrongReasoning()).isTrue();
    }
}
