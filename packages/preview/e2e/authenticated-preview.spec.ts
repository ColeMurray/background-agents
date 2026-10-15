import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures";
import { PREVIEW_REPLY } from "../src/ready";

const PROMPT = "Verify streaming and persistence through the real stack.";

test("member creates, streams and reloads a persisted conversation", async ({ page, preview }) => {
  const { webOrigin } = preview.ready;
  const failedApis: string[] = [];
  page.on("response", (response) => {
    if (response.url().startsWith(`${webOrigin}/api/`) && response.status() >= 400)
      failedApis.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  await page.goto(webOrigin);
  await expect(page.getByRole("heading", { name: "Welcome to OpenInspect Preview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Signed in as Preview member" })).toBeVisible();
  await expect(page.getByRole("button", { name: "preview-app", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Agent, model and effort/ })).toBeEnabled();
  await preview.modal.hold();
  await page.getByRole("textbox", { name: "What do you want to build?" }).fill(PROMPT);
  await page.getByRole("button", { name: "Send (Cmd/Ctrl+Enter)", exact: true }).click();
  await expect(page).toHaveURL(/\/session\/[a-f0-9]{32}$/);
  await expect(page.getByRole("status", { name: "Connection status: Connected" })).toBeVisible();
  await expect(
    page.getByText(PREVIEW_REPLY.slice(0, Math.floor(PREVIEW_REPLY.length / 2)), { exact: true })
  ).toBeVisible();
  await expect(page.getByText("Execution complete", { exact: true })).toHaveCount(0);
  await preview.modal.release();
  await expect(page.getByText(PREVIEW_REPLY, { exact: true })).toBeVisible();
  await expect(page.getByText("Execution complete", { exact: true })).toHaveCount(1);
  expect((await preview.modal.promptsReceived()).map(({ content }) => content)).toEqual([PROMPT]);
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
  const { webOrigin, userIds } = preview.ready;
  await page.goto(webOrigin);
  const viewer = await browser.newContext();
  try {
    await preview.signIn(viewer, "viewer");
    const viewerPage = await viewer.newPage();
    await viewerPage.goto(webOrigin);
    await expect(
      viewerPage.getByRole("button", { name: "Signed in as Preview viewer" })
    ).toBeVisible();
    await expect(
      viewerPage.getByRole("textbox", { name: "What do you want to build?" })
    ).toHaveCount(0);
    expect(
      (
        await viewer.request.post(`${webOrigin}/api/sessions`, { data: { name: "Forbidden" } })
      ).status()
    ).toBe(403);
    const member = await (await page.request.get(`${webOrigin}/api/auth/get-session`)).json();
    const reader = await (await viewer.request.get(`${webOrigin}/api/auth/get-session`)).json();
    expect(member.user.id).toBe(userIds.member);
    expect(reader.user.id).toBe(userIds.viewer);
    await page.getByRole("button", { name: "Signed in as Preview member" }).click();
    await page.getByRole("menuitem", { name: /Sign out/i }).click();
    await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    expect((await page.request.get(`${webOrigin}/api/sessions`)).status()).toBe(401);
    await page.goto(webOrigin);
    await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    const viewerAfterLogout = await (
      await viewer.request.get(`${webOrigin}/api/auth/get-session`)
    ).json();
    expect(viewerAfterLogout?.user?.id).toBe(userIds.viewer);
    expect((await viewer.request.get(`${webOrigin}/api/sessions`)).status()).toBe(200);
  } finally {
    await viewer.close();
  }
});

test("a person's own browser signs in, switches and signs back in with sign-in links", async ({
  browser,
  preview,
}) => {
  const { webOrigin, signInLinks } = preview.ready;
  // No stored login: this context stands in for someone's everyday browser.
  const person = await browser.newContext();
  try {
    const page = await person.newPage();
    await page.goto(signInLinks.owner);
    await expect(page).toHaveURL(`${webOrigin}/`);
    const owner = page.getByRole("button", { name: "Signed in as Preview owner" });
    await expect(owner).toBeVisible();
    await owner.click();
    await page.getByRole("menuitem", { name: /Sign out/i }).click();
    await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    await page.goto(signInLinks.owner);
    await expect(owner).toBeVisible();
    await page.goto(signInLinks.viewer);
    await expect(page.getByRole("button", { name: "Signed in as Preview viewer" })).toBeVisible();
    expect(
      (
        await person.request.post(`${webOrigin}/api/sessions`, { data: { name: "Forbidden" } })
      ).status()
    ).toBe(403);
    await page.goto(signInLinks.anonymous);
    await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    expect((await person.request.get(`${webOrigin}/api/sessions`)).status()).toBe(401);
  } finally {
    await person.close();
  }
});

// Last: it stops the launcher every test above shares, and its clean exit judges their whole run.
test("Ctrl-C, even pressed twice, stops the launcher cleanly and frees the checkout", async ({
  preview,
}) => {
  expect(await preview.interrupt()).toEqual({ code: 0, signal: null });
  expect(preview.stdout()).toContain('{"status":"stopped","clean":true}');
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  expect(existsSync(`${root}/.preview/lock.json`)).toBe(false);
  expect(existsSync(preview.ready.runDir)).toBe(false);
});
