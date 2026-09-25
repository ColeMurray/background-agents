import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const workflowsDirectory = new URL("../.github/workflows/", import.meta.url);

test("workflows that read .nvmrc run when it changes", async () => {
  const names = (await readdir(workflowsDirectory)).filter((name) => name.endsWith(".yml"));
  const consumers = [];

  for (const name of names) {
    const workflow = await readFile(new URL(name, workflowsDirectory), "utf8");
    if (!workflow.includes("node-version-file: .nvmrc")) continue;
    consumers.push(name);

    // Triggers end at the first top-level key after `on:`.
    const triggers = workflow.match(/^on:\n((?:[ #].*\n|\n)*)/m)?.[1] ?? "";
    const filters = triggers.split(/^ {4}paths:\n/m).slice(1);
    for (const filter of filters) {
      const entries = filter.match(/^(?: {6}.*\n)*/)[0];
      assert.match(entries, /^ {6}- "\.nvmrc"$/m, `${name} has a paths filter without .nvmrc`);
    }
  }

  assert.ok(consumers.length > 0, "expected at least one workflow to read .nvmrc");
});
