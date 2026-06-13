# Using OpenCode Go Models

OpenCode Go is OpenCode's subscription provider. It is separate from OpenAI ChatGPT OAuth and uses
provider IDs in the `opencode-go/*` namespace.

OpenCode also exposes free models under the `opencode/*` namespace. Those models do not require
`OPENCODE_GO_API_KEY`.

## Setup

1. Add your OpenCode Go API key as a secret:

   | Secret Name           | Value                    |
   | --------------------- | ------------------------ |
   | `OPENCODE_GO_API_KEY` | Your OpenCode Go API key |

2. For a single-tenant deployment, use a global secret. Use a repository secret only when you want a
   different OpenCode Go key for one repository.
3. Enable one or more OpenCode Go models in **Settings > Models** if they are not already visible.
4. Start a new session and select an `opencode-go/*` model, such as `opencode-go/kimi-k2.7-code`.

## Free OpenCode Models

Free OpenCode models appear under **OpenCode Free** in the model selector. Current IDs include:

- `opencode/big-pickle`
- `opencode/deepseek-v4-flash-free`
- `opencode/mimo-v2.5-free`
- `opencode/nemotron-3-ultra-free`
- `opencode/north-mini-code-free`

## How It Works

Secrets are decrypted by the control plane and injected into newly created sandboxes. The sandbox
runtime writes `OPENCODE_GO_API_KEY` into OpenCode's local `auth.json` as:

```json
{
  "opencode-go": {
    "type": "api",
    "key": "..."
  }
}
```

The key is never logged by the sandbox runtime. Existing sandboxes must be restarted to receive a
new or updated key.
