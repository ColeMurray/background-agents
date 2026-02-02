import type {
  ModalPort,
  CreateSandboxRequest,
  SandboxResponse,
  SnapshotResponse,
} from "../ports/modal-port";
import { createModalClient } from "../sandbox/client";
import { generateInternalToken } from "@open-inspect/shared";

export class ModalAdapter implements ModalPort {
  constructor(
    private apiSecret: string,
    private workspace: string
  ) {}

  async createSandbox(request: CreateSandboxRequest): Promise<SandboxResponse> {
    const client = createModalClient(this.apiSecret, this.workspace);
    return client.createSandbox(request);
  }

  async snapshotSandbox(
    sandboxId: string,
    sessionId: string,
    reason: string
  ): Promise<SnapshotResponse> {
    const client = createModalClient(this.apiSecret, this.workspace);
    const modalApiUrl = client.getSnapshotSandboxUrl();
    const authToken = await generateInternalToken(this.apiSecret);

    const response = await fetch(modalApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        sandbox_id: sandboxId,
        session_id: sessionId,
        reason: reason,
      }),
    });

    const result = (await response.json()) as {
      success: boolean;
      data?: { image_id: string };
      error?: string;
    };

    if (!result.success || !result.data?.image_id) {
      throw new Error(result.error || "Snapshot failed");
    }

    return {
      snapshotId: result.data.image_id,
    };
  }
}
