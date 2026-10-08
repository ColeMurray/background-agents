locals {
  name_suffix              = var.deployment_name
  use_modal_backend        = contains(["modal", "modal-vm"], var.sandbox_provider)
  use_daytona_backend      = var.sandbox_provider == "daytona"
  use_vercel_backend       = var.sandbox_provider == "vercel"
  use_opencomputer_backend = var.sandbox_provider == "opencomputer"
  use_e2b_backend          = var.sandbox_provider == "e2b"

  # A complete OAuth credential pair is the deployment's provider enablement
  # declaration. Runtime validation mirrors these plan-time invariants.
  github_oauth_enabled = trimspace(var.github_client_id) != "" && trimspace(var.github_client_secret) != ""
  google_enabled       = trimspace(var.google_client_id) != "" && trimspace(var.google_client_secret) != ""
  provider_neutral_admission_enabled = (
    length([for item in split(",", var.allowed_email_domains) : trimspace(item) if trimspace(item) != ""]) > 0 ||
    length([for item in split(",", var.allowed_emails) : trimspace(item) if trimspace(item) != ""]) > 0
  )
  github_admission_enabled = (
    length([for item in split(",", var.allowed_users) : trimspace(item) if trimspace(item) != ""]) > 0 ||
    length([for item in split(",", var.allowed_github_orgs) : trimspace(item) if trimspace(item) != ""]) > 0
  )
  admission_allowlist_enabled = local.provider_neutral_admission_enabled || local.github_admission_enabled
  unsafe_allow_all_effective  = var.unsafe_allow_all_users && !local.admission_allowlist_enabled

  # URLs for cross-service configuration
  control_plane_host = "open-inspect-control-plane-${local.name_suffix}.${var.cloudflare_worker_subdomain}.workers.dev"
  control_plane_url  = "https://${local.control_plane_host}"
  ws_url             = "wss://${local.control_plane_host}"

  # Must match the deployed Worker's `name` and the custom-domain `service` binding.
  web_worker_name = "open-inspect-web-${local.name_suffix}"

  # Custom-domain inputs normalized to "" when unset. coalesce() must not be
  # used here: it errors when all arguments are null or empty strings, which is
  # the default for both variables.
  web_custom_domain         = var.cloudflare_custom_domain == null ? "" : trimspace(var.cloudflare_custom_domain)
  web_custom_domain_zone_id = var.cloudflare_zone_id == null ? "" : trimspace(var.cloudflare_zone_id)

  # Whether a custom domain is configured for the Cloudflare web Worker
  web_custom_domain_enabled = (
    var.web_platform == "cloudflare" &&
    local.web_custom_domain != "" &&
    local.web_custom_domain_zone_id != ""
  )

  # The bots derive their classifier's provider from the model id alone, so the
  # deployment binds exactly one provider credential to them. This is scoped to
  # the classifier — var.anthropic_api_key is still what Claude coding sessions
  # and the opencomputer control-plane path use.
  #
  # Same regex source as MODEL_ID_PATTERNS in packages/shared/src/classification.ts.
  # Go and JavaScript regex engines still differ on \r, \v, and non-ASCII
  # whitespace, so plan can accept an id containing them that the bots reject.
  classifier_model_patterns = {
    anthropic = "^(?:anthropic/(?<model>\\s*\\S.*)|claude-\\s*\\S.*)$"
    openai    = "^(?:openai/(?<model>\\s*\\S.*)|gpt-\\s*\\S.*)$"
    bedrock   = "^bedrock/(?<region>[a-z]{2}(?:-[a-z]+)+-[0-9]+)/(?<model>(?:[a-z]+(?:-[a-z]+)?\\.)?anthropic\\.claude-[a-z0-9-]+(?::[0-9]+)?)$"
  }

  classifier_provider = one([
    for provider, pattern in local.classifier_model_patterns : provider
    if can(regex(pattern, var.classification_model))
  ])

  # The dedicated classifier key keeps the bots' credential out of sandboxes;
  # existing deployments that only set anthropic_api_key keep using it.
  classifier_anthropic_api_key = (trimspace(var.classification_anthropic_api_key) != ""
    ? var.classification_anthropic_api_key
    : var.anthropic_api_key
  )

  classifier_secret_bindings = local.classifier_provider == null ? {} : {
    anthropic = { ANTHROPIC_API_KEY = { value = local.classifier_anthropic_api_key } }
    openai    = { OPENAI_API_KEY = { value = var.classification_openai_api_key } }
    bedrock   = { BEDROCK_API_KEY = { value = var.classification_bedrock_api_key } }
  }[local.classifier_provider]

  # Bound only when set, so an unconfigured classifier keeps the model default.
  classifier_reasoning_effort_bindings = var.classification_reasoning_effort != "" ? {
    CLASSIFICATION_REASONING_EFFORT = { value = var.classification_reasoning_effort }
  } : {}

  # Deployment-wide LLM keys injected into Modal session sandboxes. Every key stays
  # present with an empty value when unconfigured, so clearing one reconciles the
  # old credential away on the next apply; Modal rejects a secret with no keys at
  # all. An empty value means sandboxes take that provider's credential from the
  # per-repository secret store, which overrides this secret either way.
  modal_llm_secret_values = {
    ANTHROPIC_API_KEY = trimspace(var.anthropic_api_key)
  }

  # OpenComputer reads its sandbox credentials from the control plane rather than
  # from a provider-side secret, so its bindings are set together.
  opencomputer_enabled = trimspace(var.opencomputer_api_key) != "" && trimspace(var.opencomputer_api_url) != ""

  # Host the Cloudflare web Worker is served from: custom domain when configured,
  # otherwise its default workers.dev hostname.
  web_cloudflare_host = (local.web_custom_domain_enabled
    ? local.web_custom_domain
    : "${local.web_worker_name}.${var.cloudflare_worker_subdomain}.workers.dev"
  )

  # Web app URL depends on deployment platform
  web_app_url = (var.web_platform == "cloudflare"
    ? "https://${local.web_cloudflare_host}"
    : "https://open-inspect-${local.name_suffix}.vercel.app"
  )
  effective_web_app_url = (
    var.web_platform == "vercel" ? module.web_app[0].production_url : local.web_app_url
  )

  # Documentation site hostname, null when unset. The Terraform workflow passes
  # an unset repository variable as "", which must not attach an empty domain.
  docs_custom_domain = (
    var.docs_custom_domain == null ? null :
    trimspace(var.docs_custom_domain) == "" ? null : trimspace(var.docs_custom_domain)
  )

  # Documentation site URL, when it serves a hostname of its own
  docs_custom_domain_url = local.docs_custom_domain != null ? "https://${local.docs_custom_domain}" : null

  # Worker script paths (deterministic output locations)
  control_plane_script_path = "${var.project_root}/packages/control-plane/dist/index.js"
  slack_bot_script_path     = "${var.project_root}/packages/slack-bot/dist/index.js"
  linear_bot_script_path    = "${var.project_root}/packages/linear-bot/dist/index.js"
  github_bot_script_path    = "${var.project_root}/packages/github-bot/dist/index.js"
}
