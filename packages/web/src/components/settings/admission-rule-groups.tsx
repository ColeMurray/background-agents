import type { AdmissionRules } from "@open-inspect/shared/admission-settings";
import { Button } from "@/components/ui/button";

export const ADMISSION_RULE_GROUPS = [
  {
    key: "allowedEmails",
    label: "Email address",
    title: "Email addresses",
    help: "Exact verified emails, including verified secondary GitHub emails. GitHub and Google.",
    placeholder: "person@example.com",
    environment: "ALLOWED_EMAILS",
    terraform: "allowed_emails",
  },
  {
    key: "allowedEmailDomains",
    label: "Email domain",
    title: "Email domains",
    help: "Any verified email at this exact domain. Subdomains are not included. GitHub and Google.",
    placeholder: "example.com",
    environment: "ALLOWED_EMAIL_DOMAINS",
    terraform: "allowed_email_domains",
  },
  {
    key: "allowedGitHubUsers",
    label: "GitHub username",
    title: "GitHub usernames",
    help: "Bare GitHub usernames, without @ or a URL. GitHub sign-in only.",
    placeholder: "octocat",
    environment: "ALLOWED_USERS",
    terraform: "allowed_users",
  },
  {
    key: "allowedGitHubOrganizations",
    label: "GitHub organization",
    title: "GitHub organizations",
    help: "Active organization members. GitHub sign-in only. Saving does not verify membership.",
    placeholder: "my-organization",
    environment: "ALLOWED_GITHUB_ORGS",
    terraform: "allowed_github_orgs",
  },
] as const satisfies readonly {
  key: keyof AdmissionRules;
  label: string;
  title: string;
  help: string;
  placeholder: string;
  environment: string;
  terraform: string;
}[];

export function AdmissionRuleGroups({
  deployment,
  draft,
  disabled,
  onChange,
}: {
  deployment: AdmissionRules;
  draft: AdmissionRules;
  disabled: boolean;
  onChange: (rules: AdmissionRules) => void;
}) {
  return (
    <div className="space-y-5">
      {ADMISSION_RULE_GROUPS.map((group) => {
        const values = [...new Set([...deployment[group.key], ...draft[group.key]])].sort();
        return (
          <section key={group.key} aria-label={group.title} className="min-w-0">
            <h4 className="text-sm font-medium text-foreground">{group.title}</h4>
            <p className="mt-1 text-xs text-muted-foreground">{group.help}</p>
            <p className="mt-1 break-words text-xs text-muted-foreground">
              Deployment: <code>{group.environment}</code> / <code>{group.terraform}</code>{" "}
              (read-only)
            </p>
            <ul className="mt-2 divide-y divide-border rounded-md border border-border">
              {values.map((entry) => {
                const fromDeployment = deployment[group.key].includes(entry);
                const fromSettings = draft[group.key].includes(entry);
                return (
                  <li key={entry} className="flex flex-wrap items-center gap-2 p-3">
                    <span className="min-w-0 basis-full break-all font-mono text-sm text-foreground sm:basis-0 sm:flex-1">
                      {entry}
                    </span>
                    <span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
                      {fromDeployment && fromSettings
                        ? "Both"
                        : fromDeployment
                          ? "Deployment"
                          : "Settings"}
                    </span>
                    {fromSettings && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={disabled}
                        aria-label={`Remove settings ${group.label.toLowerCase()} ${entry}`}
                        onClick={() =>
                          onChange({
                            ...draft,
                            [group.key]: draft[group.key].filter((item) => item !== entry),
                          })
                        }
                      >
                        {fromDeployment ? "Remove settings copy" : "Remove"}
                      </Button>
                    )}
                    {fromDeployment && fromSettings && (
                      <p className="basis-full text-xs text-muted-foreground">
                        Both sources allow this entry. Removing its settings copy leaves deployment
                        access unchanged.
                      </p>
                    )}
                  </li>
                );
              })}
              {!values.length && (
                <li className="p-3 text-sm text-muted-foreground">No rules of this type.</li>
              )}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
