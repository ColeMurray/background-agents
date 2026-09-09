variable "project_name" {
  description = "Name of the Vercel project"
  type        = string
}

variable "team_id" {
  description = "Vercel team ID"
  type        = string
}

variable "framework" {
  description = "Framework preset (e.g., 'nextjs', 'vite', 'remix')"
  type        = string
  default     = "nextjs"
}

variable "git_repository" {
  description = "Git repository configuration"
  type = object({
    type              = string # "github", "gitlab", "bitbucket"
    repo              = string # "owner/repo"
    production_branch = optional(string, "main")
  })
  default = null
}

variable "root_directory" {
  description = "Root directory of the project in the repository"
  type        = string
  default     = null
}

variable "build_command" {
  description = "Custom build command"
  type        = string
  default     = null
}

variable "output_directory" {
  description = "Output directory for the build"
  type        = string
  default     = null
}

variable "install_command" {
  description = "Custom install command"
  type        = string
  default     = null
}

variable "ignore_command" {
  description = "Command to determine if a build should be skipped"
  type        = string
  default     = null
}

variable "serverless_region" {
  description = "Region for serverless functions"
  type        = string
  default     = "iad1" # US East (N. Virginia)
}

variable "environment_variables" {
  description = "List of environment variables"
  type = list(object({
    key     = string
    value   = string
    targets = list(string) # ["production", "preview", "development"]
  }))
  default   = []
  sensitive = true
}

variable "custom_domain" {
  description = "Custom domain for the project"
  type        = string
  default     = null
}

variable "auto_assign_custom_domains" {
  description = "Automatically assign custom domains to deployments"
  type        = bool
  default     = true
}
