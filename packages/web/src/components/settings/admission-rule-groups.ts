import type { AdmissionRules } from "@open-inspect/shared/admission-settings";

export const ADMISSION_RULE_GROUPS = [
  {
    key: "allowedEmails",
    label: "Email address",
    environment: "ALLOWED_EMAILS",
    terraform: "allowed_emails",
  },
  {
    key: "allowedEmailDomains",
    label: "Email domain",
    environment: "ALLOWED_EMAIL_DOMAINS",
    terraform: "allowed_email_domains",
  },
  {
    key: "allowedGitHubUsers",
    label: "GitHub username",
    environment: "ALLOWED_USERS",
    terraform: "allowed_users",
  },
  {
    key: "allowedGitHubOrganizations",
    label: "GitHub organization",
    environment: "ALLOWED_GITHUB_ORGS",
    terraform: "allowed_github_orgs",
  },
] as const satisfies readonly {
  key: keyof AdmissionRules;
  label: string;
  environment: string;
  terraform: string;
}[];
