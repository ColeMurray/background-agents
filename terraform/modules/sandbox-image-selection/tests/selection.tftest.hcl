variables {
  releases = {
    for provider in ["modal", "daytona", "e2b", "vercel", "opencomputer"] : provider => {
      schemaVersion = 1
      baseReleaseId = sha256("a")
      artifact      = { provider = provider, scope = "test-account", reference = "test-artifact" }
      identity = {
        recipeDigest    = sha256("b")
        inventoryDigest = sha256("c")
        target          = provider
        runtimeVersion  = "v62"
        osPackages      = [for n in range(1000) : "package-${n}=1.2.3"]
      }
      verification = { identity = { osPackages = [for n in range(1000) : "package-${n}=1.2.3"] } }
    }
  }
}

run "large_evidence_is_projected_to_compact_configuration" {
  command = plan
  assert {
    condition     = length(output.json) < 5000 && length(output.releases) == 5
    error_message = "All five providers must fit without dropping selections."
  }
  assert {
    condition     = !strcontains(output.json, "osPackages") && !strcontains(output.json, "verification")
    error_message = "Verification evidence must not enter runtime configuration."
  }
}

run "oversized_configuration_is_rejected" {
  command = plan
  variables {
    releases = {
      modal = {
        schemaVersion = 1
        baseReleaseId = sha256("a")
        artifact      = { provider = "modal", scope = "account", reference = join("", [for n in range(1000) : "ééé"]) }
        identity = {
          recipeDigest    = sha256("b")
          inventoryDigest = sha256("c")
          target          = "modal"
          runtimeVersion  = "v62"
        }
      }
    }
  }
  expect_failures = [output.json]
}
