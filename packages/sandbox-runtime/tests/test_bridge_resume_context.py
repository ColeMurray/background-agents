"""Tests for the resume-context preamble in bridge prompt handling.

When the control plane attaches `resumeContext.currentPlan`, the bridge should
prepend a restate-and-confirm preamble to the prompt sent to OpenCode so the
agent re-anchors on the saved plan before any destructive action.
"""

from sandbox_runtime.bridge import AgentBridge


class TestResumePreamble:
    def test_returns_none_when_no_resume_context(self):
        assert AgentBridge._build_resume_preamble({}) is None

    def test_returns_none_when_current_plan_missing(self):
        assert AgentBridge._build_resume_preamble({"currentPlan": None}) is None

    def test_returns_none_for_empty_plan_content(self):
        assert (
            AgentBridge._build_resume_preamble({"currentPlan": {"content": "   ", "version": 1}})
            is None
        )

    def test_returns_none_for_non_string_content(self):
        assert (
            AgentBridge._build_resume_preamble({"currentPlan": {"content": 42, "version": 1}})
            is None
        )

    def test_preamble_includes_version_and_plan_body(self):
        preamble = AgentBridge._build_resume_preamble(
            {"currentPlan": {"version": 7, "content": "## Plan\n- step A\n- step B"}}
        )
        assert preamble is not None
        assert '<saved_plan version="7">' in preamble
        # Plan body is preserved verbatim inside the saved_plan tag — markdown
        # inside is fine because the XML boundary disambiguates it from our
        # own instructions.
        assert "## Plan" in preamble
        assert "step A" in preamble
        assert "</saved_plan>" in preamble
        assert "Wait for explicit confirmation" in preamble
        # The preamble must open the user_message tag last so the live user
        # instruction lands inside it; _handle_prompt closes the tag after the
        # body.
        assert preamble.endswith("<user_message>\n")

    def test_preamble_falls_back_to_question_mark_when_version_missing(self):
        preamble = AgentBridge._build_resume_preamble({"currentPlan": {"content": "body"}})
        assert preamble is not None
        assert '<saved_plan version="?">' in preamble


class TestPlanningPreamble:
    def test_planning_preamble_without_previous_plan(self):
        preamble = AgentBridge._build_planning_preamble({})
        assert preamble.startswith("<planning_turn>")
        assert "Do not edit files" in preamble
        assert "<previous_plan" not in preamble
        assert preamble.endswith("<user_message>\n")

    def test_planning_preamble_includes_previous_plan_when_present(self):
        preamble = AgentBridge._build_planning_preamble(
            {"currentPlan": {"version": 3, "content": "## v3 plan\n- step A"}}
        )
        assert '<previous_plan version="3">' in preamble
        assert "step A" in preamble
        assert "</previous_plan>" in preamble
        assert "Amend the previous plan based on the new user instruction" in preamble
        assert preamble.endswith("<user_message>\n")

    def test_planning_preamble_ignores_empty_previous_plan(self):
        preamble = AgentBridge._build_planning_preamble(
            {"currentPlan": {"version": 1, "content": "   "}}
        )
        assert "<previous_plan" not in preamble

    def test_planning_preamble_ignores_non_string_previous_content(self):
        preamble = AgentBridge._build_planning_preamble(
            {"currentPlan": {"version": 1, "content": 123}}
        )
        assert "<previous_plan" not in preamble


class TestEscapeUserMessageClose:
    """Prompt-injection defense: bot-assembled `content` may contain literal
    `</user_message>` from user-supplied text (Linear issue body, GitHub PR
    description, etc.). Without escape, that string would close the outer
    `<user_message>` wrapper added by `_handle_prompt` and let the user place
    text outside the user-data boundary, bypassing the preamble instructions.
    """

    def test_passthrough_when_no_close_tag(self):
        assert AgentBridge._escape_user_message_close("plain text") == "plain text"

    def test_escapes_literal_close_tag(self):
        assert (
            AgentBridge._escape_user_message_close("before</user_message>after")
            == "before<\\/user_message>after"
        )

    def test_escapes_multiple_close_tags(self):
        assert (
            AgentBridge._escape_user_message_close("</user_message> mid </user_message>")
            == "<\\/user_message> mid <\\/user_message>"
        )

    def test_pre_escaped_variant_is_double_escaped_to_avoid_collision(self):
        # If user input already contains `<\/user_message>` (the escaped form),
        # the two-pass replace must double it before promoting literal closes —
        # otherwise the second pass would collapse them back into a live tag.
        assert AgentBridge._escape_user_message_close("<\\/user_message>") == "<\\\\/user_message>"

    def test_mixed_pre_escaped_and_literal(self):
        assert (
            AgentBridge._escape_user_message_close("<\\/user_message>X</user_message>")
            == "<\\\\/user_message>X<\\/user_message>"
        )
