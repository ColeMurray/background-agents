"use client";
import { useState } from "react";
import useSWR from "swr";
import { projectRequest, useProjectMutations, type ProjectView } from "@/hooks/use-projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Link from "next/link";
type WorkItem = {
  rootSession: { id: string; title: string | null; status: string };
  descendantSessions: { id: string; title: string | null }[];
  lane: string;
  pullRequests: { id: string; url: string; state: string }[];
};
const field = "w-full rounded border border-border bg-background p-2";
export function ProjectSessions({
  project,
  board = false,
}: {
  project: ProjectView;
  board?: boolean;
}) {
  const [bucket, setBucket] = useState("recent");
  const { data, error } = useSWR<{ items: WorkItem[]; hasMore: boolean }>(
    `/api/projects/${project.id}/sessions?bucket=${board ? "board" : bucket}`,
    projectRequest
  );
  const write = useProjectMutations();
  const [failure, setFailure] = useState("");
  const cards = (items: WorkItem[]) =>
    items.map((item) => (
      <article key={item.rootSession.id} className="my-2 rounded border p-3">
        <Link href={`/session/${item.rootSession.id}`} className="font-medium hover:underline">
          {item.rootSession.title || item.rootSession.id}
        </Link>
        <p className="text-xs text-muted-foreground">{item.rootSession.status}</p>
        {item.descendantSessions.map((child) => (
          <Link
            className="mt-2 block text-sm underline"
            key={child.id}
            href={`/session/${child.id}`}
          >
            {child.title || child.id}
          </Link>
        ))}
      </article>
    ));
  return (
    <section>
      <h2 className="text-xl font-semibold">{board ? "Pull request board" : "Sessions"}</h2>
      {!board && (
        <select
          aria-label="Session bucket"
          className={`${field} my-3`}
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
        >
          {["recent", "needs_attention", "in_progress", "finished"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      )}
      {error ? (
        <p role="alert">Unable to load sessions.</p>
      ) : !data ? (
        <p>Loading work…</p>
      ) : board ? (
        <div className="mt-3 grid gap-3 md:grid-cols-5">
          {["no_pr", "draft", "open", "merged", "closed"].map((lane) => (
            <section key={lane}>
              <h3 className="text-sm font-medium capitalize">{lane.replace("_", " ")}</h3>
              {cards(data.items.filter((item) => item.lane === lane))}
            </section>
          ))}
        </div>
      ) : (
        cards(data.items)
      )}
      {data?.hasMore && (
        <Link className="underline" href={`/sessions?projectId=${project.id}`}>
          See all sessions
        </Link>
      )}
      {!board && project.capabilities.canAssociateSessions && (
        <form
          className="mt-4 flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            try {
              await write(
                `/api/sessions/${encodeURIComponent(String(form.get("sessionId")))}/project`,
                "PUT",
                { projectId: project.id, includeChildren: form.get("children") === "on" }
              );
            } catch (cause) {
              setFailure(String(cause));
            }
          }}
        >
          <Input
            name="sessionId"
            aria-label="Existing session"
            placeholder="Existing session ID"
            required
          />
          <label>
            <input name="children" type="checkbox" defaultChecked /> Include child sessions
          </label>
          <Button>Add session</Button>
        </form>
      )}
      {failure && <p role="alert">{failure}</p>}
    </section>
  );
}
export function ProjectPullRequests({ id }: { id: string }) {
  const { data, error } = useSWR<{
    pullRequests: {
      id: string;
      url: string;
      state: string;
      isDraft: boolean;
      branch: string;
      sessionId: string;
      providerUpdatedAt: number | null;
    }[];
  }>(`/api/projects/${id}/pull-requests`, projectRequest);
  return (
    <section>
      <h2 className="text-xl font-semibold">Pull requests</h2>
      {error && <p role="alert">Unable to load pull requests.</p>}
      {data?.pullRequests.length === 0 && <p>No pull requests yet.</p>}
      {data?.pullRequests.map((pr) => (
        <article key={pr.id} className="mt-3 flex flex-wrap gap-4 rounded border p-3">
          <a href={pr.url} rel="noreferrer" target="_blank" className="underline">
            {pr.branch}
          </a>
          <span>{pr.isDraft ? "draft" : pr.state}</span>
          <Link href={`/session/${pr.sessionId}`}>Session</Link>
          {pr.providerUpdatedAt && <time>{new Date(pr.providerUpdatedAt).toLocaleString()}</time>}
        </article>
      ))}
    </section>
  );
}
