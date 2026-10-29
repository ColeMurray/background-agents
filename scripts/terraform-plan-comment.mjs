import { readFileSync, writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

const MAX_PLAN_BYTES = 60000;
const [inputPath, outputPath, outcome] = process.argv.slice(2);
if (!inputPath || !outputPath || !["success", "failure"].includes(outcome)) {
  throw new Error("Usage: terraform-plan-comment.mjs <plan-file> <comment-file> <success|failure>");
}

// HTML-escape inside <pre> so backticks and closing tags cannot escape the plan block.
const escapedPlan = stripVTControlCharacters(readFileSync(inputPath, "utf8"))
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");
const planBytes = Buffer.from(escapedPlan);
// Avoid partial UTF-8 characters or HTML entities at the truncation boundary.
const plan = new TextDecoder()
  .decode(planBytes.subarray(0, MAX_PLAN_BYTES), { stream: true })
  .replace(/&[^;]*$/, "");
const truncationNote = planBytes.length > MAX_PLAN_BYTES ? "\n... (truncated)" : "";

writeFileSync(
  outputPath,
  `### Terraform Plan Results

**Status:** ${outcome === "success" ? "Success" : "Failed"}

<details><summary>Show Plan</summary>

<pre>${plan}${truncationNote}</pre>

</details>

*Pushed by: @${process.env.GITHUB_ACTOR}*
`
);
