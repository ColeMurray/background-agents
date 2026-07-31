import { z } from "zod";
import type { CompleteImageBuildCallback, FailImageBuildCallback } from "./types";

export const imageBuildFinalizationJobSchema = z.object({
  version: z.literal(1),
  buildId: z.string().min(1),
  completionHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type ImageBuildFinalizationJob = z.infer<typeof imageBuildFinalizationJobSchema>;

export interface ImageBuildFinalizationQueue {
  send(job: ImageBuildFinalizationJob): Promise<void>;
}

type FinalizationOutcome =
  | { outcome: "success"; completion: CompleteImageBuildCallback & { providerSessionId: string } }
  | { outcome: "failure"; failure: FailImageBuildCallback & { providerSessionId: string } };

export async function createImageBuildFinalizationJob(
  result: FinalizationOutcome
): Promise<ImageBuildFinalizationJob> {
  const buildId = result.outcome === "success" ? result.completion.buildId : result.failure.buildId;
  const canonical =
    result.outcome === "success"
      ? {
          buildId,
          providerSessionId: result.completion.providerSessionId,
          outcome: result.outcome,
          repositoryShas: result.completion.repositoryShas?.map((repository) => ({
            repoOwner: repository.repoOwner.toLowerCase(),
            repoName: repository.repoName.toLowerCase(),
            baseSha: repository.baseSha,
          })),
          runtimeVersion: result.completion.runtimeVersion,
          buildDurationMs: result.completion.buildDurationMs,
        }
      : {
          buildId,
          providerSessionId: result.failure.providerSessionId,
          outcome: result.outcome,
          errorMessage: result.failure.errorMessage,
        };

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical))
  );
  const completionHash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return { version: 1, buildId, completionHash };
}
