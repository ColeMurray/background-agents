"use client";

import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import {
  addTeamRepositoryGrantRequestSchema,
  teamRepositoryGrantSchema,
  teamRepositoryGrantsResponseSchema,
  type TeamRepositoryGrant,
} from "@open-inspect/shared/types/teams";
import { useRepos } from "@/hooks/use-repos";
import { useTeamCapabilities } from "@/hooks/use-team-capabilities";
import type { TeamResponse } from "@/hooks/use-teams";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";

export function TeamRepositories({ team }: { team: TeamResponse }) {
  const { data: session, status } = useAuthSession();
  const { mutate } = useSWRConfig();
  const { canManageRepositories } = useTeamCapabilities(team);
  const archived = team.archivedAt !== null;
  const catalog = useRepos(canManageRepositories && !archived);
  const teamPath = `/api/teams/${encodeURIComponent(team.id)}` as const;
  const path = `${teamPath}/repository-grants` as const;
  const result = useSWR<{ grants: TeamRepositoryGrant[] }, Error>(
    session?.user.id ? ([path, session.user.id] as const) : null,
    async ([requestPath]: readonly [BrowserApiPath, string]) => {
      const response = await browserApiFetch(requestPath);
      if (!response.ok) throw new Error(`Unable to load repository grants (${response.status})`);
      return teamRepositoryGrantsResponseSchema.parse(await response.json());
    },
    { keepPreviousData: false }
  );
  const grants = session?.user.id && !result.error ? (result.data?.grants ?? []) : [];
  const loading = status === "loading" || result.isLoading;
  const [draftKind, setDraftKind] = useState<"installation" | "repository">("repository");
  const [repoId, setRepoId] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const installationWide = grants.some((grant) => grant.kind === "installation");
  // Existing grants fix the scope until removed; the store rejects mixed kinds.
  const kind = grants[0]?.kind ?? draftKind;
  const available = catalog.repos.filter(
    (repo) => !grants.some((grant) => grant.repoExternalId === repo.id)
  );
  const selectedRepo = available.find((repo) => String(repo.id) === repoId);
  const disabled =
    archived || pending || loading || !!result.error || !result.data || !session?.user.id;

  async function changeGrant(
    change: { add: z.input<typeof addTeamRepositoryGrantRequestSchema> } | { remove: string }
  ) {
    if (!canManageRepositories || disabled) return;
    setPending(true);
    setMessage(null);
    try {
      const adding = "add" in change;
      const response = await browserApiFetch(
        adding ? path : `${path}/${encodeURIComponent(change.remove)}`,
        adding
          ? {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(addTeamRepositoryGrantRequestSchema.parse(change.add)),
            }
          : { method: "DELETE" }
      );
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        const alreadyAbsent =
          !adding && response.status === 404 && failure?.error === "Repository grant not found";
        if (!alreadyAbsent) {
          const error =
            typeof failure?.error === "string" ? failure.error : "Repository grant update failed";
          throw new Error(typeof failure?.code === "string" ? `${error} (${failure.code})` : error);
        }
      }
      let nextGrants: TeamRepositoryGrant[];
      if (adding) {
        const { grant } = z
          .object({ grant: teamRepositoryGrantSchema })
          .parse(await response.json());
        nextGrants = [...grants.filter((existing) => existing.id !== grant.id), grant];
        setRepoId("");
      } else {
        nextGrants = grants.filter((grant) => grant.id !== change.remove);
      }
      await result.mutate({ grants: nextGrants }, { revalidate: false });
      await Promise.allSettled([
        result.mutate(),
        mutate(teamPath),
        mutate(`/api/repos?teamId=${encodeURIComponent(team.id)}`),
        mutate(`/api/environments?teamId=${encodeURIComponent(team.id)}`),
      ]);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Repository grant update failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="team-repositories-heading" className="space-y-4">
      <div>
        <h2 id="team-repositories-heading" className="text-lg font-semibold text-foreground">
          Repositories
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Repository grants determine which installation repositories this team can use.
        </p>
      </div>
      {message && <ErrorBanner role="alert">{message}</ErrorBanner>}
      {result.error && (
        <ErrorBanner role="alert">
          Unable to load repository grants.{" "}
          <Button size="xs" variant="outline" onClick={() => void result.mutate()}>
            Retry
          </Button>
        </ErrorBanner>
      )}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading repository grants...
        </p>
      ) : (
        !result.error &&
        session?.user.id &&
        result.data && (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {grants.length === 0 && (
              <li className="p-4 text-sm text-muted-foreground">
                This team has no repository grants.
              </li>
            )}
            {grants.map((grant) => {
              const label =
                grant.kind === "installation"
                  ? "All installation repositories"
                  : `${grant.owner}/${grant.name}`;
              return (
                <li
                  key={grant.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-4"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="break-words text-sm font-medium text-foreground">{label}</p>
                    <Badge>
                      {grant.kind === "installation"
                        ? "Installation-wide grant"
                        : "Named repository grant"}
                    </Badge>
                    {grant.kind === "installation" && (
                      <p className="text-xs text-muted-foreground">
                        Includes current and future repositories accessible to the installation.
                      </p>
                    )}
                  </div>
                  {canManageRepositories && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      aria-label={`Remove grant for ${label}`}
                      onClick={() => void changeGrant({ remove: grant.id })}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )
      )}
      {canManageRepositories && (
        <div className="space-y-3 rounded-lg border border-border p-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Add repository grant
          </h3>
          <p className="text-xs text-muted-foreground">
            Choose installation-wide access or named repositories, not both. Remove existing grants
            to switch scope.
          </p>
          {archived && (
            <p className="text-sm text-muted-foreground">
              Archived teams cannot change repository grants.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="team-grant-kind" className="text-sm font-medium">
              Grant scope
            </label>
            <select
              id="team-grant-kind"
              value={kind}
              disabled={disabled || grants.length > 0}
              onChange={(event) =>
                setDraftKind(event.target.value === "installation" ? "installation" : "repository")
              }
              className="max-w-full rounded border border-border bg-background px-2 py-2 text-sm disabled:opacity-50"
            >
              <option value="repository" disabled={installationWide}>
                Named repositories
              </option>
              <option
                value="installation"
                disabled={grants.some((grant) => grant.kind === "repository")}
              >
                All installation repositories
              </option>
            </select>
            {kind === "repository" && (
              <>
                <label htmlFor="team-grant-repository" className="text-sm font-medium">
                  Repository
                </label>
                <select
                  id="team-grant-repository"
                  value={selectedRepo ? repoId : ""}
                  disabled={disabled || catalog.loading || !!catalog.error}
                  onChange={(event) => setRepoId(event.target.value)}
                  className="min-w-0 max-w-full flex-1 rounded border border-border bg-background px-2 py-2 text-sm disabled:opacity-50"
                >
                  <option value="">Select an installation repository</option>
                  {available.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.fullName}
                    </option>
                  ))}
                </select>
              </>
            )}
            <Button
              disabled={
                disabled ||
                installationWide ||
                (kind === "repository" && (!selectedRepo || catalog.loading || !!catalog.error))
              }
              onClick={() => {
                if (kind === "installation") void changeGrant({ add: { kind: "installation" } });
                else if (selectedRepo)
                  void changeGrant({
                    add: {
                      kind: "repository",
                      repoExternalId: selectedRepo.id,
                      owner: selectedRepo.owner,
                      name: selectedRepo.name,
                    },
                  });
              }}
            >
              Add grant
            </Button>
          </div>
          {kind === "repository" && catalog.loading && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading installation repositories...
            </p>
          )}
          {kind === "repository" && catalog.error && (
            <ErrorBanner role="alert">Unable to load installation repositories.</ErrorBanner>
          )}
          {kind === "repository" &&
            !catalog.loading &&
            !catalog.error &&
            available.length === 0 &&
            !archived && (
              <p className="text-sm text-muted-foreground">
                No additional installation repositories available.
              </p>
            )}
        </div>
      )}
    </section>
  );
}
