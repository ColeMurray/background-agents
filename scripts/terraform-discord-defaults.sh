# Sourced by Terraform plan/apply. Actions renders missing inputs as empty
# strings; leave them unset so variables.tf remains the only default authority.
# Do not trim nonempty overrides: Terraform must reject malformed values.
for name in TF_VAR_discord_bot_default_model TF_VAR_discord_bot_harness; do
  if [[ -z "${!name:-}" ]]; then
    unset "$name"
  fi
done
