"use client";
import { useState } from "react";
import useSWR from "swr";
import { projectRequest, useProjectMutations, type ProjectView } from "@/hooks/use-projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import type { ProjectPin } from "@open-inspect/shared/types/projects";
import { SafeMarkdown } from "@/components/safe-markdown";
import { ProjectSessions } from "./project-work";
const field = "w-full rounded border border-border bg-background p-2";
export function ProjectOverview({ project }: { project: ProjectView }) {
  const { data, error } = useSWR<{ pins: (ProjectPin & { unavailable?: boolean })[] }>(
    `/api/projects/${project.id}/pins`,
    projectRequest
  );
  const write = useProjectMutations();
  const [failure, setFailure] = useState("");
  const [editingPin, setEditingPin] = useState<ProjectPin>();
  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-xl font-semibold">Brief</h2>
        <SafeMarkdown content={project.brief || "No brief yet."} imageMode="omit" />
        {new TextEncoder().encode(project.brief ?? "").length > 8000 && (
          <p className="mt-2 text-sm text-amber-600">
            The creation context will truncate this brief. Agents can read the full brief with the
            project tool.
          </p>
        )}
      </section>
      <section>
        <h2 className="text-xl font-semibold">Status summary</h2>
        <p className="mt-2 whitespace-pre-wrap">
          {project.statusSummary || "No status update yet."}
        </p>
        {project.capabilities.canEditMetadata && (
          <form
            className="mt-3 space-y-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await write(`/api/projects/${project.id}/status-summary`, "PUT", {
                  statusSummary: new FormData(e.currentTarget).get("summary"),
                });
              } catch (cause) {
                setFailure(String(cause));
              }
            }}
          >
            <textarea
              aria-label="Status summary"
              name="summary"
              defaultValue={project.statusSummary ?? ""}
              maxLength={4000}
              rows={3}
              className={field}
            />
            <Button>Save summary</Button>
          </form>
        )}
      </section>
      <section>
        <h2 className="text-xl font-semibold">Decisions and pinned links</h2>
        {error && <p role="alert">Unable to load pins.</p>}
        <div className="mt-3 space-y-3">
          {data?.pins.map((pin) => (
            <article key={pin.id} className="rounded border p-3">
              <h3 className="font-medium">{pin.title}</h3>
              {pin.kind === "decision" && (
                <>
                  <time className="text-xs text-muted-foreground">
                    {new Date(pin.decidedAt ?? pin.createdAt).toLocaleDateString(undefined, {
                      timeZone: "UTC",
                    })}
                  </time>
                  <SafeMarkdown content={pin.body ?? ""} imageMode="omit" />
                </>
              )}
              {pin.kind === "link" && pin.url && (
                <a href={pin.url} target="_blank" rel="noreferrer" className="underline">
                  Open link
                </a>
              )}
              {pin.kind === "artifact" && !pin.unavailable && (
                <Link
                  href={`/session/${pin.sessionId}?artifact=${encodeURIComponent(pin.artifactId ?? "")}`}
                  className="underline"
                >
                  Open artifact in session
                </Link>
              )}
              {project.capabilities.canManagePins && !pin.unavailable && (
                <Button variant="ghost" onClick={() => setEditingPin(pin)}>
                  Edit
                </Button>
              )}
              {project.capabilities.canManagePins && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await write(`/api/projects/${project.id}/pins/${pin.id}`, "DELETE");
                    } catch (cause) {
                      setFailure(String(cause));
                    }
                  }}
                >
                  Remove
                </Button>
              )}
            </article>
          ))}
        </div>
        {project.capabilities.canManagePins && (
          <PinForm
            key={editingPin?.id ?? "new"}
            pin={editingPin}
            onDone={() => setEditingPin(undefined)}
            project={project}
            onError={setFailure}
          />
        )}
      </section>
      {failure && (
        <p role="alert" className="text-red-500">
          {failure}
        </p>
      )}
      <ProjectSessions project={project} board />
    </div>
  );
}
function PinForm({
  project,
  onError,
  pin,
  onDone,
}: {
  project: ProjectView;
  onError: (value: string) => void;
  pin?: ProjectPin;
  onDone: () => void;
}) {
  const [kind, setKind] = useState(pin?.kind ?? "decision");
  const write = useProjectMutations();
  return (
    <form
      className="mt-4 space-y-2 rounded border p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const data = new FormData(form);
        try {
          await write(`/api/projects/${project.id}/pins${pin ? `/${pin.id}` : ""}`, "PUT", {
            kind,
            title: data.get("title"),
            position: Number(data.get("position")),
            ...(kind === "decision"
              ? { body: data.get("body"), decidedAt: new Date(String(data.get("date"))).getTime() }
              : kind === "link"
                ? { url: data.get("url") }
                : { sessionId: data.get("sessionId"), artifactId: data.get("artifactId") }),
          });
          form.reset();
          onDone();
        } catch (cause) {
          onError(String(cause));
        }
      }}
    >
      <select
        aria-label="Pin type"
        value={kind}
        onChange={(e) => setKind(e.target.value as ProjectPin["kind"])}
        className={field}
      >
        {["decision", "link", "artifact"].map((value) => (
          <option key={value}>{value}</option>
        ))}
      </select>
      <Input
        aria-label="Pin title"
        name="title"
        defaultValue={pin?.title}
        placeholder="Title"
        required
        maxLength={200}
      />
      {kind === "decision" ? (
        <>
          <Input
            name="date"
            aria-label="Decision date"
            type="date"
            defaultValue={new Date(pin?.decidedAt ?? Date.now()).toISOString().slice(0, 10)}
            required
          />
          <textarea
            name="body"
            aria-label="Decision"
            defaultValue={pin?.body ?? ""}
            maxLength={4000}
            className={field}
          />
        </>
      ) : kind === "link" ? (
        <Input name="url" aria-label="Link URL" defaultValue={pin?.url ?? ""} type="url" required />
      ) : (
        <>
          <Input
            name="sessionId"
            defaultValue={pin?.sessionId ?? ""}
            aria-label="Artifact session"
            placeholder="Session ID"
            required
          />
          <Input
            name="artifactId"
            defaultValue={pin?.artifactId ?? ""}
            aria-label="Artifact"
            placeholder="Artifact ID"
            required
          />
        </>
      )}
      <Input
        name="position"
        aria-label="Pin order"
        type="number"
        min={0}
        max={10000}
        defaultValue={pin?.position ?? 0}
      />
      <Button>{pin ? "Save pin" : "Add pin"}</Button>
      {pin && (
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      )}
    </form>
  );
}
