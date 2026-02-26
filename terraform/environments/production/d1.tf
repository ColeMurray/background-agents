# =============================================================================
# Cloudflare D1 Database
# =============================================================================

resource "cloudflare_d1_database" "main" {
  account_id = var.cloudflare_account_id
  name       = "open-inspect-${local.name_suffix}"

  read_replication = {
    mode = "disabled"
  }
}

resource "null_resource" "d1_migrations" {
  depends_on = [cloudflare_d1_database.main]

  triggers = {
    database_id = cloudflare_d1_database.main.id
    migrations_sha = sha256(join(",", [
      for f in sort(fileset("${var.project_root}/terraform/d1/migrations", "*.sql")) :
      filesha256("${var.project_root}/terraform/d1/migrations/${f}")
    ]))
  }

  provisioner "local-exec" {
    command     = "bash scripts/d1-migrate.sh ${cloudflare_d1_database.main.name} terraform/d1/migrations"
    working_dir = var.project_root

    environment = {
      CLOUDFLARE_ACCOUNT_ID = var.cloudflare_account_id
      CLOUDFLARE_API_TOKEN  = var.cloudflare_api_token
    }
  }
}
