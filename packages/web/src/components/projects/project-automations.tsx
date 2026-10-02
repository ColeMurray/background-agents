"use client";
import { useState } from "react";
import useSWR from "swr";
import { projectRequest, useProjectMutations, type ProjectView } from "@/hooks/use-projects";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import type { Automation } from "@open-inspect/shared/types/automations";
const field = "w-full rounded border border-border bg-background p-2";
export function ProjectAutomations({ project }: { project: ProjectView }) {
  const { data, error, mutate } = useSWR<{ automations: Automation[] }>(
    "/api/automations?limit=100",
    projectRequest
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
      {(error || failure) && <p role="alert">{failure || String(error)}</p>}
      {data?.automations
        .filter((automation) => automation.projectId === project.id)
        .map((automation) => (
          <div className="flex gap-3" key={automation.id}>
            <Link href={`/automations/${automation.id}`}>{automation.name}</Link>
            {project.capabilities.canSubscribeAutomations && (
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
          {data?.automations
            .filter((automation) => automation.projectId !== project.id)
            .map((automation) => (
              <option key={automation.id} value={automation.id}>
                {automation.name}
              </option>
            ))}
        </select>
      )}
    </section>
  );
}
