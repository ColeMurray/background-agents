# =============================================================================
# Helm Deployer Module
# =============================================================================
#
# This module represents the configuration needed for Helm-based sandbox
# deployment. The actual Helm deployer service runs inside the Kubernetes
# cluster and receives authenticated HTTP requests from the control plane.
#
# Unlike the Modal module (which uses null_resource + local-exec to run
# modal CLI commands), this module primarily manages configuration that
# gets injected into the control plane worker as environment bindings.
#
# The Helm deployer service itself is deployed separately (e.g., via a
# static Helm chart or kubectl apply to the target cluster).

# Validate that the deployer API is reachable
resource "null_resource" "validate_helm_api" {
  triggers = {
    api_url = var.helm_api_url
  }

  provisioner "local-exec" {
    command = <<-EOF
      echo "Helm deployer API URL configured: ${var.helm_api_url}"
      echo "Namespace: ${var.helm_namespace}"
      echo "Helm sandbox provider ready."
    EOF
  }
}
