import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (name) => readFile(new URL(name, root), "utf8");
const codeBlocks = (markdown) =>
  [...markdown.matchAll(/^```[^\n]*\n[\s\S]*?^```/gm)].map(([block]) => block);
const headings = (markdown) =>
  [...markdown.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "").matchAll(/^(#+) /gm)].map(
    ([, level]) => level.length
  );
const destinations = (markdown) =>
  [...markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)]
    .map(([, destination]) => destination)
    .filter((destination) => !["README.md", "README.zh-CN.md"].includes(destination));

test("English and Simplified Chinese READMEs link to each other", async () => {
  assert.match(await read("README.md"), /\[简体中文\]\(README\.zh-CN\.md\)/);
  assert.match(await read("README.zh-CN.md"), /\[English\]\(README\.md\)/);
});

test("Chinese README covers the English structure and preserves executable examples", async () => {
  const english = await read("README.md");
  const chinese = await read("README.zh-CN.md");
  assert.deepEqual(headings(chinese), headings(english));
  assert.deepEqual(codeBlocks(chinese), codeBlocks(english));
});

test("Chinese README preserves documentation, package, image, and external link destinations", async () => {
  const englishLinks = destinations(await read("README.md"));
  const chineseLinks = destinations(await read("README.zh-CN.md"));
  assert.deepEqual(chineseLinks, englishLinks);
  for (const destination of new Set(chineseLinks)) {
    if (/^https?:\/\//.test(destination)) continue;
    await access(new URL(destination.split("#")[0], root));
  }
});
