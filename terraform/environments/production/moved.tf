# =============================================================================
# State Address Moves
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
