# Reasoning contract catalog fixture

Public model metadata selected from `https://models.opencode.ai/api.json` during the September 4,
2026 investigation. The source snapshot SHA-256 was
`ef112420273b7e572ef9c87db13a2f30fe1a562c29ea30d365b911889f9ff46c`.

`reasoning-models.json` includes only the OpenAI and Anthropic models offered by this repository at
implementation time, with the provider fields and model capabilities, limits, costs, and reasoning
metadata used by OpenCode. No auth or deployment data is included. The subset SHA-256 is
`18e7e0ca29f785f273d50776d9d96f6dd2be6e754d62d14d73b23325d7eac6da`.

Run with OpenCode 1.18.18 and model fetching disabled. Update this fixture and its checksum
deliberately when changing the model catalog or the binary; otherwise a live catalog change can
alter variants without a code change. The contract suite iterates this frozen fixture, not the
shared TypeScript catalog. Reconcile the model/effort sets whenever changing shared model
definitions. Contract mocks do not establish live provider acceptance of every listed setting.
