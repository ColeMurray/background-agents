mock_provider "cloudflare" {}

variables {
  account_id       = "test-account"
  worker_name      = "script-sha256-test"
  worker_subdomain = "test-account"
  # Any existing file stands in for a bundle: the provider is mocked, so only
  # the checksum precondition reads it.
  script_path = "main.tf"
}

# Unpinned is the local-build path: whatever is on disk deploys, as before.
run "unpinned_bundle_plans" {
  command = plan
}

run "matching_checksum_plans" {
  command = plan

  variables {
    script_sha256 = filesha256("main.tf")
  }
}

# A stale or swapped bundle must fail the plan rather than ship.
run "mismatched_checksum_fails_the_plan" {
  command = plan

  variables {
    script_sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
  }

  expect_failures = [cloudflare_worker_version.this]
}
