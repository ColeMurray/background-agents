"use client";
import { useState } from "react";
import { useAutomations } from "@/hooks/use-automations";
import { useProjectMutations, type ProjectView } from "@/hooks/use-projects";
import { Button } from "@/components/ui/button";
import Link from "next/link";
const field = "w-full rounded border border-border bg-background p-2";
export function ProjectAutomations({ project }: { project: ProjectView }) {
  const { automations, error, mutate, loading, loadingMore, hasMore, loadMore } = useAutomations(
    "",
    project.ownerTeamId ?? "null"
  );
  const scopedAutomations = automations.filter(
    (automation) => automation.ownerTeamId === project.ownerTeamId
  );
  const [failure, setFailure] = useState("");
  const write = useProjectMutations();
  const assign = async (id: string, projectId: string | null) => {
    try {
      await write(`/api/automations/${id}`, "PUT", { projectId });
      await mutate();
    } catch (cause) {
      setFailure(String(cause));
    }
  };
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold">Subscribed automations</h2>
      {loading && <p role="status">Loading automations…</p>}
      {(error || failure) && <p role="alert">{failure || String(error)}</p>}
      {scopedAutomations
        .filter((automation) => automation.projectId === project.id)
        .map((automation) => (
          <div className="flex gap-3" key={automation.id}>
            <Link href={`/automations/${automation.id}`}>{automation.name}</Link>
            {project.capabilities.canSubscribeAutomations && automation.capabilities.canManage && (
              <Button variant="ghost" onClick={() => assign(automation.id, null)}>
                Unsubscribe
              </Button>
            )}
          </div>
        ))}
      {project.capabilities.canSubscribeAutomations && (
        <select
          aria-label="Subscribe automation"
          value=""
          className={field}
          onChange={(e) => {
            if (e.target.value) void assign(e.target.value, project.id);
          }}
        >
          <option value="">Subscribe an automation…</option>
          {scopedAutomations
            .filter(
              (automation) =>
                automation.projectId !== project.id && automation.capabilities.canManage
            )
            .map((automation) => (
              <option key={automation.id} value={automation.id}>
                {automation.name}
              </option>
            ))}
        </select>
      )}
      {hasMore && (
        <Button variant="ghost" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? "Loading…" : "Load more automations"}
        </Button>
      )}
    </section>
  );
}
