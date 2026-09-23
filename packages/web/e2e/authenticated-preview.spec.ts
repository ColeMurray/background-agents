import { test, expect } from "./fixtures";
import { PREVIEW_REPLY } from "../../control-plane/test/preview/contracts";

test("member creates, streams and reloads a persisted conversation", async ({ page, preview }) => {
  const failedApis: string[] = [];
  page.on("response", (response) => {
    if (response.url().startsWith(`${preview.manifest.webOrigin}/api/`) && response.status() >= 400)
      failedApis.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  await page.goto(preview.manifest.webOrigin);
  await expect(page.getByRole("heading", { name: "Welcome to OpenInspect Preview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Signed in as Preview member" })).toBeVisible();
  await expect(page.getByRole("button", { name: "preview-app", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Agent, model and effort/ })).toBeEnabled();
  preview.backend.modal.holdTurns();
  await page
    .getByRole("textbox", { name: "What do you want to build?" })
    .fill("Verify streaming and persistence through the real stack.");
  await page.getByRole("button", { name: "Send (Cmd/Ctrl+Enter)", exact: true }).click();
  await expect(page).toHaveURL(/\/session\/[a-f0-9]{32}$/);
  await expect(page.getByRole("status", { name: "Connection status: Connected" })).toBeVisible();
  await expect(
    page.getByText(PREVIEW_REPLY.slice(0, Math.floor(PREVIEW_REPLY.length / 2)), { exact: true })
  ).toBeVisible();
  await expect(page.getByText("Execution complete", { exact: true })).toHaveCount(0);
  preview.backend.modal.releaseTurns();
  await expect(page.getByText(PREVIEW_REPLY, { exact: true })).toBeVisible();
  await expect(page.getByText("Execution complete", { exact: true })).toHaveCount(1);
  const sessionId = new URL(page.url()).pathname.split("/").at(-1)!;
  const messages = await preview.backend.request(`/sessions/${sessionId}/messages`);
  expect(messages.ok).toBe(true);
  const data = await messages.json();
  expect(data.messages).toHaveLength(1);
  expect(data.messages[0].status).toBe("completed");
  expect(preview.backend.modal.state.promptsReceived[0].messageId).toBe(data.messages[0].id);
  await page.reload();
  await expect(page.getByText(PREVIEW_REPLY, { exact: true })).toBeVisible();
  await expect(page.getByText("Execution complete", { exact: true })).toHaveCount(1);
  expect(failedApis).toEqual([]);
});

test("viewer is isolated, read-only and denied by the BFF; logout stays revoked", async ({
  page,
  browser,
  preview,
}) => {
  const origin = preview.manifest.webOrigin;
  await page.goto(origin);
  const viewer = await browser.newContext({
    storageState: preview.manifest.personas.viewer.statePath,
  });
  try {
    const viewerPage = await viewer.newPage();
    await viewerPage.goto(origin);
    await expect(
      viewerPage.getByRole("button", { name: "Signed in as Preview viewer" })
    ).toBeVisible();
    await expect(
      viewerPage.getByRole("textbox", { name: "What do you want to build?" })
    ).toHaveCount(0);
    expect(
      (
        await viewer.request.post(`${origin}/api/sessions`, { data: { name: "Forbidden" } })
      ).status()
    ).toBe(403);
    const member = await (await page.request.get(`${origin}/api/auth/get-session`)).json();
    const reader = await (await viewer.request.get(`${origin}/api/auth/get-session`)).json();
    expect(member.user.id).toBe(preview.manifest.personas.member.userId);
    expect(reader.user.id).toBe(preview.manifest.personas.viewer.userId);
    await page.getByRole("button", { name: "Signed in as Preview member" }).click();
    await page.getByRole("menuitem", { name: /Sign out/i }).click();
    await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    expect((await page.request.get(`${origin}/api/sessions`)).status()).toBe(401);
    await page.goto(origin);
    await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    const viewerAfterLogout = await (
      await viewer.request.get(`${origin}/api/auth/get-session`)
    ).json();
    expect(viewerAfterLogout?.user?.id).toBe(preview.manifest.personas.viewer.userId);
    expect((await viewer.request.get(`${origin}/api/sessions`)).status()).toBe(200);
    expect((await preview.backend.request("/sessions")).status).toBe(401);
  } finally {
    await viewer.close();
  }
});

test("a person's own browser signs in, switches and signs back in with sign-in links", async ({
  browser,
  preview,
}) => {
  // No stored login: this context stands in for someone's everyday browser.
  const person = await browser.newContext();
  try {
    const page = await person.newPage();
    await page.goto(preview.signInLinks.owner);
    await expect(page).toHaveURL(`${preview.manifest.webOrigin}/`);
    const owner = page.getByRole("button", { name: "Signed in as Preview owner" });
    await expect(owner).toBeVisible();
    await owner.click();
    await page.getByRole("menuitem", { name: /Sign out/i }).click();
    await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    await page.goto(preview.signInLinks.owner);
    await expect(owner).toBeVisible();
    await page.goto(preview.signInLinks.viewer);
    await expect(page.getByRole("button", { name: "Signed in as Preview viewer" })).toBeVisible();
    expect(
      (
        await person.request.post(`${preview.manifest.webOrigin}/api/sessions`, {
          data: { name: "Forbidden" },
        })
      ).status()
    ).toBe(403);
    await page.goto(preview.signInLinks.anonymous);
    await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    expect((await person.request.get(`${preview.manifest.webOrigin}/api/sessions`)).status()).toBe(
      401
    );
  } finally {
    await person.close();
  }
});
