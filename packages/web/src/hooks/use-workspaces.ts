import useSWR from "swr";
import { DEFAULT_WORKSPACE_ID, type ListWorkspacesResponse } from "@open-inspect/shared";

export function useWorkspaces() {
  const { data, isLoading } = useSWR<ListWorkspacesResponse>("/api/workspaces");
  const defaultWorkspace =
    data?.workspaces.find((workspace) => workspace.id === DEFAULT_WORKSPACE_ID) ??
    data?.workspaces[0];

  return {
    workspaces: data?.workspaces ?? [],
    defaultWorkspaceId: defaultWorkspace?.id ?? DEFAULT_WORKSPACE_ID,
    loading: isLoading,
  };
}
