mock_provider "null" {}
mock_provider "external" {}

variables {
  app_name           = "open-inspect"
  modal_token_id     = "test-token"
  modal_token_secret = "test-secret"
  workspace          = "test-workspace"
  deploy_path        = "."
  source_hash        = "test-source"
  fetch_app_info     = false
}

run "standard_omits_vm_image" {
  command = plan
  assert {
    condition     = null_resource.modal_deploy.triggers.build_vm_image == "false"
    error_message = "Standard deployments must not build the paid VM verification image."
  }
}
run "vm_image_change_forces_redeploy" {
  command = plan
  variables { build_vm_image = true }
  assert {
    condition     = null_resource.modal_deploy.triggers.build_vm_image == "true"
    error_message = "Selecting VM image provisioning must participate in deployment identity."
  }
}
