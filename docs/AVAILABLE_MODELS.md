# Available Models

Open-Inspect exposes these models in the model picker and integration preferences. The default
enabled set includes Anthropic and OpenAI models. xAI / SuperGrok, OpenCode Zen, OpenCode Go, Z.AI
Coding Plan, and DeepSeek models are available but must be enabled in **Settings > Models**. OpenAI
and SuperGrok subscriptions are configured in **Settings > Provider Accounts**; OpenCode Zen and
OpenCode Go require `OPENCODE_API_KEY`; Z.AI Coding Plan requires `ZHIPU_API_KEY`; DeepSeek requires
`DEEPSEEK_API_KEY`.

OpenAI, xAI and Anthropic session selectors offer provider policy, any active connected account, and
API-key mode. Automation editors can resolve defaults on each run or pin an account/API-key choice.
Unattended Slack, GitHub, Linear, and unpinned automation launches follow the provider's configured
unattended mode. For Anthropic that policy reaches only Claude Agent automations: Slack, GitHub and
Linear launches run on OpenCode, which uses the API key.

## Harnesses

A session runs on one agent harness, fixed at create. Which models and which Anthropic
authentication a session can use depends on it:

| Harness      | Models            | Anthropic authentication                   |
| ------------ | ----------------- | ------------------------------------------ |
| OpenCode     | every model below | `ANTHROPIC_API_KEY`                        |
| Claude Agent | Anthropic models  | `ANTHROPIC_API_KEY` or a connected account |

See [Using the Claude Agent Harness](CLAUDE_AGENT.md).

## Anthropic

Anthropic models run on both harnesses. A connected Claude subscription (Settings > Provider
Accounts) applies only on the Claude Agent harness; OpenCode sessions use `ANTHROPIC_API_KEY`.

| Model ID                      | Display name      | Description                                       | Reasoning efforts             | Default effort |
| ----------------------------- | ----------------- | ------------------------------------------------- | ----------------------------- | -------------- |
| `anthropic/claude-haiku-4-5`  | Claude Haiku 4.5  | Fast and efficient                                | high, max                     | max            |
| `anthropic/claude-sonnet-4-5` | Claude Sonnet 4.5 | Balanced performance                              | high, max                     | max            |
| `anthropic/claude-sonnet-4-6` | Claude Sonnet 4.6 | Balanced, fast coding                             | low, medium, high, max        | high           |
| `anthropic/claude-sonnet-5`   | Claude Sonnet 5   | Latest Sonnet, adaptive thinking                  | low, medium, high, xhigh, max | high           |
| `anthropic/claude-opus-4-5`   | Claude Opus 4.5   | Most capable                                      | high, max                     | max            |
| `anthropic/claude-opus-4-6`   | Claude Opus 4.6   | Most capable, adaptive thinking                   | low, medium, high, max        | high           |
| `anthropic/claude-opus-4-7`   | Claude Opus 4.7   | Most capable, adaptive thinking                   | low, medium, high, xhigh, max | high           |
| `anthropic/claude-opus-4-8`   | Claude Opus 4.8   | Most capable, adaptive thinking                   | low, medium, high, xhigh, max | high           |
| `anthropic/claude-opus-5`     | Claude Opus 5     | Latest Opus, adaptive thinking                    | low, medium, high, xhigh, max | high           |
| `anthropic/claude-fable-5`    | Claude Fable 5    | Most powerful, new tier above Opus                | low, medium, high, xhigh, max | high           |
| `anthropic/claude-fable-5-1`  | Claude Fable 5.1  | Demanding reasoning and long-horizon agentic work | low, medium, high, xhigh, max | high           |

## OpenAI

OpenAI models support connected ChatGPT provider accounts or `OPENAI_API_KEY` mode. See
[Using OpenAI Models](OPENAI_MODELS.md) for account setup and coexistence details.

| Model ID                     | Display name        | Description                                    | Reasoning efforts              | Default effort |
| ---------------------------- | ------------------- | ---------------------------------------------- | ------------------------------ | -------------- |
| `openai/gpt-5.4`             | GPT 5.4             | Flagship model                                 | none, low, medium, high, xhigh | Not set        |
| `openai/gpt-5.5`             | GPT 5.5             | Latest flagship model                          | none, low, medium, high, xhigh | Not set        |
| `openai/gpt-5.6-sol`         | GPT 5.6 Sol         | Frontier model for complex professional work   | none, low, medium, high, xhigh | Not set        |
| `openai/gpt-5.6-terra`       | GPT 5.6 Terra       | Balanced, cost-efficient everyday work         | none, low, medium, high, xhigh | Not set        |
| `openai/gpt-5.6-luna`        | GPT 5.6 Luna        | Fast, cost-efficient high-volume workloads     | none, low, medium, high, xhigh | Not set        |
| `openai/gpt-6-astra`         | GPT-6 Astra         | Most capable model for complex, demanding work | low, medium, high, xhigh, max  | medium         |
| `openai/gpt-5.3-codex`       | GPT 5.3 Codex       | Latest codex                                   | low, medium, high, xhigh       | high           |
| `openai/gpt-5.3-codex-spark` | GPT 5.3 Codex Spark | Low-latency codex variant                      | low, medium, high, xhigh       | high           |

## xAI / SuperGrok

Grok models support connected SuperGrok provider accounts or `XAI_API_KEY` mode and are disabled by
default. See [Using Grok with a SuperGrok Subscription](GROK_MODELS.md) for setup and rollout
instructions.

| Model ID             | Display name   | Description                                     | Reasoning efforts | Default effort |
| -------------------- | -------------- | ----------------------------------------------- | ----------------- | -------------- |
| `xai/grok-4.5`       | Grok 4.5       | Grok for chat, coding, and agentic tools        | low, medium, high | high           |
| `xai/grok-4.6`       | Grok 4.6       | Latest Grok for chat, coding, and agentic tools | low, medium, high | high           |
| `xai/grok-build-0.1` | Grok Build 0.1 | Coding model for SuperGrok subscribers          | Not configurable  | N/A            |

## OpenCode Zen

OpenCode Zen models require `OPENCODE_API_KEY` as a global or repository secret. Zen is
pay-per-token against `https://opencode.ai/zen/v1`.

| Model ID                | Display name | Description   | Reasoning efforts | Default effort |
| ----------------------- | ------------ | ------------- | ----------------- | -------------- |
| `opencode/kimi-k2.5`    | Kimi K2.5    | Moonshot AI   | Not supported     | N/A            |
| `opencode/kimi-k2.6`    | Kimi K2.6    | Moonshot AI   | Not supported     | N/A            |
| `opencode/kimi-k3`      | Kimi K3      | Moonshot AI   | Not supported     | N/A            |
| `opencode/minimax-m2.5` | MiniMax M2.5 | MiniMax       | Not supported     | N/A            |
| `opencode/qwen3.7-max`  | Qwen3.7 Max  | Alibaba Cloud | Not supported     | N/A            |
| `opencode/glm-5`        | GLM 5        | Z.ai 744B MoE | Not supported     | N/A            |
| `opencode/glm-5.1`      | GLM 5.1      | Z.ai          | Not supported     | N/A            |
| `opencode/glm-5.2`      | GLM 5.2      | Z.ai          | Not supported     | N/A            |

## OpenCode Go

[OpenCode Go](https://opencode.ai/docs/go/) is a flat-rate subscription over the same credential as
Zen: one `OPENCODE_API_KEY` global or repository secret serves both. Go routes to a separate gateway
(`https://opencode.ai/zen/go/v1`) and bills against the subscription's rolling usage allowance
instead of per token, so a key without an active Go subscription fails on `opencode-go/*` models
while still working on `opencode/*` ones.

Usage is capped on three rolling windows — 20% of the monthly allowance per 5 hours, 50% per week,
100% per month. Allowances differ per model, so an unattended session pinned to a Go model can
exhaust its window and fail mid-run; keep Go models off unattended Slack, GitHub, Linear, and
automation launches unless you accept that.

The catalog mirrors the model list Go publishes under
[Endpoints](https://opencode.ai/docs/go/#endpoints), in the same order, with one exception: Go
documents `minimax-m2.5`, but the OpenCode release pinned in
`packages/sandbox-images/toolchain.json` does not resolve `opencode-go/minimax-m2.5`
(`opencode models` lists 27 Go models, not 28), so it is left out rather than offered as a selection
that fails. That model is reachable as `opencode/minimax-m2.5` on Zen.

| Model ID                                   | Display name                 | Description                   | Reasoning efforts | Default effort |
| ------------------------------------------ | ---------------------------- | ----------------------------- | ----------------- | -------------- |
| `opencode-go/grok-4.6`                     | Grok 4.6                     | xAI                           | Not supported     | N/A            |
| `opencode-go/gpt-5.6-luna`                 | GPT 5.6 Luna                 | OpenAI                        | Not supported     | N/A            |
| `opencode-go/glm-5.3-flash`                | GLM 5.3 Flash                | Z.ai                          | Not supported     | N/A            |
| `opencode-go/glm-5.3`                      | GLM 5.3                      | Z.ai                          | Not supported     | N/A            |
| `opencode-go/glm-5.2`                      | GLM 5.2                      | Z.ai                          | Not supported     | N/A            |
| `opencode-go/glm-5.1`                      | GLM 5.1                      | Z.ai                          | Not supported     | N/A            |
| `opencode-go/kimi-k3`                      | Kimi K3                      | Moonshot AI                   | Not supported     | N/A            |
| `opencode-go/kimi-k2.7-code`               | Kimi K2.7 Code               | Moonshot AI                   | Not supported     | N/A            |
| `opencode-go/kimi-k2.6`                    | Kimi K2.6                    | Moonshot AI                   | Not supported     | N/A            |
| `opencode-go/longcat-2.0`                  | LongCat 2.0                  | Meituan                       | Not supported     | N/A            |
| `opencode-go/deepseek-v4.1-flash`          | DeepSeek V4.1 Flash          | DeepSeek                      | Not supported     | N/A            |
| `opencode-go/deepseek-v4-pro`              | DeepSeek V4 Pro              | DeepSeek                      | Not supported     | N/A            |
| `opencode-go/deepseek-v4-flash`            | DeepSeek V4 Flash            | DeepSeek                      | Not supported     | N/A            |
| `opencode-go/deepseek-v4-flash-vision-exp` | DeepSeek V4 Flash Vision Exp | DeepSeek, experimental vision | Not supported     | N/A            |
| `opencode-go/mimo-v2.5`                    | MiMo V2.5                    | Xiaomi                        | Not supported     | N/A            |
| `opencode-go/mimo-v2.5-pro`                | MiMo V2.5 Pro                | Xiaomi                        | Not supported     | N/A            |
| `opencode-go/minimax-m3`                   | MiniMax M3                   | MiniMax                       | Not supported     | N/A            |
| `opencode-go/minimax-m2.7`                 | MiniMax M2.7                 | MiniMax                       | Not supported     | N/A            |
| `opencode-go/muse-spark-1.3-contributor`   | Muse Spark 1.3 Contributor   | Multimodal contributor tier   | Not supported     | N/A            |
| `opencode-go/muse-spark-1.2-contributor`   | Muse Spark 1.2 Contributor   | Multimodal contributor tier   | Not supported     | N/A            |
| `opencode-go/qwen3.8-max`                  | Qwen3.8 Max                  | Alibaba Cloud                 | Not supported     | N/A            |
| `opencode-go/qwen3.8-flash`                | Qwen3.8 Flash                | Alibaba Cloud                 | Not supported     | N/A            |
| `opencode-go/qwen3.7-max`                  | Qwen3.7 Max                  | Alibaba Cloud                 | Not supported     | N/A            |
| `opencode-go/qwen3.7-plus`                 | Qwen3.7 Plus                 | Alibaba Cloud                 | Not supported     | N/A            |
| `opencode-go/qwen3.6-plus`                 | Qwen3.6 Plus                 | Alibaba Cloud                 | Not supported     | N/A            |
| `opencode-go/hy4-preview`                  | Hy4 Preview                  | Tencent Hunyuan               | Not supported     | N/A            |
| `opencode-go/hy3`                          | Hy3                          | Tencent Hunyuan               | Not supported     | N/A            |

Some of these models are reachable through more than one provider, billed against different
credentials. `opencode-go/grok-4.6` and `xai/grok-4.6` are the same Grok model behind different
gateways; `opencode-go/glm-5.2`, `opencode/glm-5.2` and `zai-coding-plan/glm-5.2` are the same GLM
model behind three. Pick the entry whose billing you want.

These models run on the OpenCode harness only — the Claude Agent harness runs Anthropic models
exclusively.

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
