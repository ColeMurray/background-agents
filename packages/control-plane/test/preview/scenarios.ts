import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import { FIXTURE_REPOSITORY } from "./github-fixture";
import type { Persona } from "./personas";

export type PreviewRequest = (
  path: string,
  init?: { method?: string; body?: unknown; persona?: Persona }
) => Promise<Response>;
import type { Scenario } from "./contracts";
export { SCENARIOS, type Scenario } from "./contracts";

export async function waitFor<T>(
  description: string,
  probe: () => Promise<T | false>,
  timeoutMs = 20_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== false) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function expectJson<T>(response: Response): Promise<T> {
  if (!response.ok)
    throw new Error(
      `Request failed: ${response.status} ${new URL(response.url || "http://preview").pathname}`
    );
  return response.json() as Promise<T>;
}

export async function populateScenario(
  scenario: Scenario,
  request: PreviewRequest
): Promise<Record<string, string>> {
  const aliases: Record<string, string> = { fixtureRepository: FIXTURE_REPOSITORY.full_name };
  await expectJson(await request("/repos"));
  await expectJson(await request(`/repos/${FIXTURE_REPOSITORY.full_name}/branches`));
  if (scenario === "empty") return aliases;
  const created = await expectJson<{ sessionId: string }>(
    await request("/sessions", {
      method: "POST",
      body: {
        name: "Preview conversation",
        repoOwner: "preview-org",
        repoName: "preview-app",
        model: DEFAULT_MODEL,
      },
    })
  );
  aliases.completedSession = created.sessionId;
  const prompt = await expectJson<{ messageId: string }>(
    await request(`/sessions/${created.sessionId}/prompt`, {
      method: "POST",
      body: { content: "Show me a verified preview conversation." },
    })
  );
  aliases.completedMessage = prompt.messageId;
  await waitFor("persisted preview completion", async () => {
    const data = await expectJson<{ messages: Array<{ id: string; status: string }> }>(
      await request(`/sessions/${created.sessionId}/messages`)
    );
    return (
      data.messages?.some(
        (message) => message.id === prompt.messageId && message.status === "completed"
      ) || false
    );
  });
  return aliases;
}
