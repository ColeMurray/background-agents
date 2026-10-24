# =============================================================================
# State Address Moves and Ownership Transfers
# =============================================================================

moved {
  from = module.slack_kv
  to   = module.slack_kv[0]
}

moved {
  from = null_resource.slack_bot_build
  to   = null_resource.slack_bot_build[0]
}

moved {
  from = module.slack_bot_worker
  to   = module.slack_bot_worker[0]
}

moved {
  from = module.web_app
  to   = module.web_app[0]
}

# Preview branches briefly modeled this Worker in Terraform. Forget that state
# without deleting the live script: the dedicated Wrangler workflow is now its
# sole owner and deploys migration + WASM atomically under the same name.
removed {
  from = module.pi_codemode_sandbox_worker

  lifecycle {
    destroy = false
  }
}
