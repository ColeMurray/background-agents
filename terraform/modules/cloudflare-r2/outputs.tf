output "bucket_name" {
  description = "The name of the R2 bucket"
  value       = cloudflare_r2_bucket.this.name
}
