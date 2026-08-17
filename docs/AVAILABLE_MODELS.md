# Available Models

Open-Inspect exposes these models in the model picker and integration preferences. The default
enabled set includes Anthropic and OpenAI models. xAI / SuperGrok, OpenCode Zen, Z.AI Coding Plan,
and DeepSeek models are available but must be enabled in **Settings > Models**. SuperGrok requires
managed xAI OAuth credentials; Z.AI Coding Plan requires `ZHIPU_API_KEY`; DeepSeek requires
`DEEPSEEK_API_KEY`.

## Anthropic

| Model ID                      | Display name      | Description                        | Reasoning efforts             | Default effort |
| ----------------------------- | ----------------- | ---------------------------------- | ----------------------------- | -------------- |
| `anthropic/claude-haiku-4-5`  | Claude Haiku 4.5  | Fast and efficient                 | high, max                     | max            |
| `anthropic/claude-sonnet-4-5` | Claude Sonnet 4.5 | Balanced performance               | high, max                     | max            |
| `anthropic/claude-sonnet-4-6` | Claude Sonnet 4.6 | Balanced, fast coding              | low, medium, high, max        | high           |
| `anthropic/claude-sonnet-5`   | Claude Sonnet 5   | Latest Sonnet, adaptive thinking   | low, medium, high, xhigh, max | high           |
| `anthropic/claude-opus-4-5`   | Claude Opus 4.5   | Most capable                       | high, max                     | max            |
| `anthropic/claude-opus-4-6`   | Claude Opus 4.6   | Most capable, adaptive thinking    | low, medium, high, max        | high           |
| `anthropic/claude-opus-4-7`   | Claude Opus 4.7   | Most capable, adaptive thinking    | low, medium, high, xhigh, max | high           |
| `anthropic/claude-opus-4-8`   | Claude Opus 4.8   | Most capable, adaptive thinking    | low, medium, high, xhigh, max | high           |
| `anthropic/claude-opus-5`     | Claude Opus 5     | Latest Opus, adaptive thinking     | low, medium, high, xhigh, max | high           |
| `anthropic/claude-fable-5`    | Claude Fable 5    | Most powerful, new tier above Opus | low, medium, high, xhigh, max | high           |

## OpenAI

OpenAI models require ChatGPT OAuth credentials. See [Using OpenAI Models](OPENAI_MODELS.md) for
setup instructions.

| Model ID                     | Display name        | Description                                  | Reasoning efforts              | Default effort |
| ---------------------------- | ------------------- | -------------------------------------------- | ------------------------------ | -------------- |
| `openai/gpt-5.4`             | GPT 5.4             | Flagship model                               | none, low, medium, high, xhigh | Not set        |
| `openai/gpt-5.5`             | GPT 5.5             | Latest flagship model                        | none, low, medium, high, xhigh | Not set        |
| `openai/gpt-5.6-sol`         | GPT 5.6 Sol         | Frontier model for complex professional work | none, low, medium, high, xhigh | Not set        |
| `openai/gpt-5.6-terra`       | GPT 5.6 Terra       | Balanced, cost-efficient everyday work       | none, low, medium, high, xhigh | Not set        |
| `openai/gpt-5.6-luna`        | GPT 5.6 Luna        | Fast, cost-efficient high-volume workloads   | none, low, medium, high, xhigh | Not set        |
| `openai/gpt-5.3-codex`       | GPT 5.3 Codex       | Latest codex                                 | low, medium, high, xhigh       | high           |
| `openai/gpt-5.3-codex-spark` | GPT 5.3 Codex Spark | Low-latency codex variant                    | low, medium, high, xhigh       | high           |

## xAI / SuperGrok

Grok models require a SuperGrok OAuth refresh token and are disabled by default. See
[Using Grok with a SuperGrok Subscription](GROK_MODELS.md) for setup and rollout instructions.

| Model ID             | Display name   | Description                                     | Reasoning efforts | Default effort |
| -------------------- | -------------- | ----------------------------------------------- | ----------------- | -------------- |
| `xai/grok-4.5`       | Grok 4.5       | Grok for chat, coding, and agentic tools        | low, medium, high | high           |
| `xai/grok-4.6`       | Grok 4.6       | Latest Grok for chat, coding, and agentic tools | low, medium, high | high           |
| `xai/grok-build-0.1` | Grok Build 0.1 | Coding model for SuperGrok subscribers          | Not configurable  | N/A            |

## OpenCode Zen

| Model ID                | Display name | Description   | Reasoning efforts | Default effort |
| ----------------------- | ------------ | ------------- | ----------------- | -------------- |
| `opencode/kimi-k2.5`    | Kimi K2.5    | Moonshot AI   | Not supported     | N/A            |
| `opencode/kimi-k2.6`    | Kimi K2.6    | Moonshot AI   | Not supported     | N/A            |
| `opencode/kimi-k3`      | Kimi K3      | Moonshot AI   | Not supported     | N/A            |
| `opencode/minimax-m2.5` | MiniMax M2.5 | MiniMax       | Not supported     | N/A            |
| `opencode/qwen3.7-max`  | Qwen3.7 Max  | Alibaba Cloud | Not supported     | N/A            |
| `opencode/glm-5`        | GLM 5        | Z.ai 744B MoE | Not supported     | N/A            |
| `opencode/glm-5.1`      | GLM 5.1      | Z.ai          | Not supported     | N/A            |

## Z.AI Coding Plan

Z.AI Coding Plan models require `ZHIPU_API_KEY` as a global or repository secret.

| Model ID                  | Display name | Description      | Reasoning efforts | Default effort |
| ------------------------- | ------------ | ---------------- | ----------------- | -------------- |
| `zai-coding-plan/glm-5.2` | GLM 5.2      | Z.AI Coding Plan | Not supported     | N/A            |
| `zai-coding-plan/glm-5.3` | GLM 5.3      | Z.AI Coding Plan | Not supported     | N/A            |

## DeepSeek

DeepSeek models require `DEEPSEEK_API_KEY` as a global or repository secret.

| Model ID                     | Display name      | Description  | Reasoning efforts | Default effort |
| ---------------------------- | ----------------- | ------------ | ----------------- | -------------- |
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash | Fast model   | Not supported     | N/A            |
| `deepseek/deepseek-v4-pro`   | DeepSeek V4 Pro   | Most capable | Not supported     | N/A            |
