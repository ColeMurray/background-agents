import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT, DELETE } = settingsProxy(
  ({ id, linearTeamId }: { id: string; linearTeamId: string }) =>
    `/teams/${encodeURIComponent(id)}/channel-bindings/linear/${encodeURIComponent(linearTeamId)}`,
  "team channel binding"
);
