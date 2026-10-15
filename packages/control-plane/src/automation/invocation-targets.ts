import type { AutomationRepository } from "@open-inspect/shared/types/automations";
import type {
  AutomationEnvironmentRow,
  AutomationRepositoryInsert,
  AutomationStore,
} from "../db/automation-store";
import type { Env } from "../types";
import { resolveAutomationRepositories } from "./repository";

interface TargetSelection {
  repositories: AutomationRepositoryInsert[];
  environments: AutomationEnvironmentRow[];
}

/** Every repository carries the snapshot used for both successful and failed children. */
export interface InvocationTargetSnapshot {
  repositories: Array<{ repository: AutomationRepository; error: string | null }>;
  environments: AutomationEnvironmentRow[];
}

/** Stored selections and already-resolved snapshots are mutually exclusive inputs. */
export type InvocationTargetInput =
  | { kind: "stored"; selection?: TargetSelection }
  | { kind: "resolved"; snapshot: InvocationTargetSnapshot };

type LoadedInvocationTargets =
  ({ kind: "stored" } & TargetSelection) | ({ kind: "resolved" } & InvocationTargetSnapshot);

/** Load both target kinds together, before deriving permission requirements. */
export async function loadInvocationTargets(
  store: Pick<AutomationStore, "getRepositoriesForAutomation" | "getEnvironmentsForAutomation">,
  automationId: string,
  input: InvocationTargetInput = { kind: "stored" }
): Promise<LoadedInvocationTargets> {
  if (input.kind === "resolved") return { kind: "resolved", ...input.snapshot };
  if (input.selection) return { kind: "stored", ...input.selection };
  const [repositories, environments] = await Promise.all([
    store.getRepositoriesForAutomation(automationId),
    store.getEnvironmentsForAutomation(automationId),
  ]);
  return { kind: "stored", repositories, environments };
}

/** Resolve only stored selections; validated snapshots never repeat their SCM lookup. */
export async function resolveInvocationTargets(
  env: Env,
  targets: LoadedInvocationTargets,
  expectedRepositoryId?: number
): Promise<InvocationTargetSnapshot> {
  if (targets.kind === "resolved") return targets;
  const resolutions = await resolveAutomationRepositories(env, targets.repositories);
  return {
    environments: targets.environments,
    repositories: resolutions.map(({ repository, requested, error }) => {
      if (
        repository &&
        expectedRepositoryId !== undefined &&
        repository.repoId !== expectedRepositoryId
      ) {
        repository = null;
        error = "Repository identity changed during event resolution";
      }
      return {
        repository: repository ?? {
          repoOwner: requested.repo_owner,
          repoName: requested.repo_name,
          repoId: requested.repo_id,
          baseBranch: requested.base_branch,
        },
        error,
      };
    }),
  };
}
