# Linear Bot Integration with Control Plane

The Linear bot requires changes to the control plane to support callback routing. This document
describes the required changes.

## Control Plane Changes

### 1. Add `LINEAR_BOT` service binding to `Env` (types.ts)

```typescript
// In packages/control-plane/src/types.ts, add to Env interface:
LINEAR_BOT?: Fetcher; // Optional - only if linear-bot is deployed
```

### 2. Make callback routing generic (durable-object.ts)

The current `notifySlackBot()` method is hardcoded to the `SLACK_BOT` binding. Replace it with a
generic `notifyCallbackClient()` that routes based on `source`:

```typescript
/**
 * Route completion callbacks based on the prompt's source.
 * Each source type maps to a service binding.
 */
private getCallbackBinding(source: string): Fetcher | undefined {
  switch (source) {
    case "slack":
      return this.env.SLACK_BOT;
    case "linear":
      return this.env.LINEAR_BOT;
    default:
      return undefined;
  }
}

/**
 * Notify the originating client of completion with retry.
 */
private async notifyCallbackClient(messageId: string, success: boolean): Promise<void> {
  const message = this.repository.getMessageCallbackContext(messageId);
  if (!message?.callback_context) {
    this.log.debug("No callback context for message, skipping notification", {
      message_id: messageId,
    });
    return;
  }
  if (!this.env.INTERNAL_CALLBACK_SECRET) {
    this.log.debug("INTERNAL_CALLBACK_SECRET not configured, skipping notification");
    return;
  }

  // Determine which service binding to use based on message source
  const source = this.repository.getMessageSource(messageId);
  const binding = this.getCallbackBinding(source || "slack");
  if (!binding) {
    this.log.debug("No callback binding for source, skipping notification", {
      message_id: messageId,
      source,
    });
    return;
  }

  // ... rest of the existing notifySlackBot logic, using `binding` instead of `this.env.SLACK_BOT`
}
```

### 3. Update prompt callbackContext type

The current type expects Slack-specific fields (`channel`, `threadTs`). Make it generic — the
callback context is opaque to the control plane:

```typescript
// In the prompt handler, change callbackContext type from:
callbackContext?: {
  channel: string;
  threadTs: string;
  repoFullName: string;
  model: string;
  reactionMessageTs?: string;
};

// To:
callbackContext?: Record<string, unknown>;
```

The control plane doesn't need to understand the callback context — it just stores it, signs it, and
passes it back to the originating client.

### 4. Terraform changes (main.tf)

Add a KV namespace, worker module, and service binding:

```hcl
# KV namespace
module "linear_kv" {
  source         = "../../modules/cloudflare-kv"
  account_id     = var.cloudflare_account_id
  namespace_name = "open-inspect-linear-kv-${local.name_suffix}"
}

# Add LINEAR_BOT service binding to control_plane_worker
service_bindings = [
  {
    binding_name = "SLACK_BOT"
    service_name = "open-inspect-slack-bot-${local.name_suffix}"
  },
  {
    binding_name = "LINEAR_BOT"
    service_name = "open-inspect-linear-bot-${local.name_suffix}"
  }
]

# Worker module
module "linear_bot_worker" {
  source      = "../../modules/cloudflare-worker"
  account_id  = var.cloudflare_account_id
  worker_name = "open-inspect-linear-bot-${local.name_suffix}"
  script_path = local.linear_bot_script_path

  kv_namespaces = [{
    binding_name = "LINEAR_KV"
    namespace_id = module.linear_kv.namespace_id
  }]

  service_bindings = [{
    binding_name = "CONTROL_PLANE"
    service_name = "open-inspect-control-plane-${local.name_suffix}"
  }]

  enable_service_bindings = var.enable_service_bindings

  plain_text_bindings = [
    { name = "CONTROL_PLANE_URL", value = local.control_plane_url },
    { name = "WEB_APP_URL", value = local.web_app_url },
    { name = "DEPLOYMENT_NAME", value = var.deployment_name },
    { name = "DEFAULT_MODEL", value = "claude-sonnet-4-20250514" },
  ]

  secrets = [
    { name = "LINEAR_WEBHOOK_SECRET", value = var.linear_webhook_secret },
    { name = "LINEAR_API_KEY", value = var.linear_api_key },
    { name = "INTERNAL_CALLBACK_SECRET", value = var.internal_callback_secret },
  ]

  compatibility_date  = "2024-09-23"
  compatibility_flags = ["nodejs_compat"]

  depends_on = [module.linear_kv, module.control_plane_worker]
}
```

### 5. New variables (variables.tf)

```hcl
variable "linear_webhook_secret" {
  description = "Linear webhook signing secret"
  type        = string
  default     = ""
  sensitive   = true
}

variable "linear_api_key" {
  description = "Linear API key for posting comments"
  type        = string
  default     = ""
  sensitive   = true
}
```
