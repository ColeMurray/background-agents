export type NoRepositoryIntent = "explicit" | "negated" | "absent";

const REPOSITORY = String.raw`(?:repos?|repositor(?:y|ies)|code(?:base)?)`;
const REPOSITORY_OBJECT = String.raw`(?:(?:a|any|the)\s+)?${REPOSITORY}`;
const NO_REPOSITORY_TARGET = String.raw`(?:no\s+(?:repos?|repositor(?:y|ies))|(?:an?\s+)?empty\s+sandbox|(?:a\s+)?(?:repo|repository)[ -]?less(?:\s+sandbox)?)`;
const COMMAND_END = String.raw`(?=\s*(?:$|,\s*please$|(?:and|for|to)\b))`;
const EXECUTION_TARGET = String.raw`(?:with\s+no\s+(?:repos?|repositor(?:y|ies))|in\s+(?:an?\s+)?empty\s+sandbox|without\s+(?:${REPOSITORY_OBJECT}|cloning(?:\s+${REPOSITORY_OBJECT})?|checking\s+out\s+(?:${REPOSITORY_OBJECT}|code))|(?:repo|repository)[ -]?less)`;

const NEGATED_PATTERNS = [
  new RegExp(
    String.raw`^(?:please\s+)?(?:do not|don't|must not|mustn't|should not|shouldn't)\s+(?:use|choose|select)\s+${NO_REPOSITORY_TARGET}${COMMAND_END}`
  ),
  new RegExp(
    String.raw`^(?:this\s+)?(?:do not|don't|must not|mustn't|should not|shouldn't)\s+(?:start|run|work)(?:\s+(?:this|the task|this request|a session))?\s+${EXECUTION_TARGET}${COMMAND_END}`
  ),
];

const EXPLICIT_PATTERNS = [
  new RegExp(
    String.raw`^(?:please\s+)?(?:use|choose|select)\s+${NO_REPOSITORY_TARGET}${COMMAND_END}`
  ),
  new RegExp(String.raw`^i\s+(?:want|need)\s+no\s+(?:repos?|repositor(?:y|ies))${COMMAND_END}`),
  new RegExp(String.raw`^i\s+(?:do not|don't)\s+need\s+${REPOSITORY_OBJECT}${COMMAND_END}`),
  new RegExp(
    String.raw`^(?:no\s+)?(?:repos?|repositor(?:y|ies))\s+(?:(?:is|are)\s+)?(?:not\s+)?(?:needed|required|necessary)${COMMAND_END}`
  ),
  new RegExp(String.raw`^please\s+no\s+(?:repos?|repositor(?:y|ies))${COMMAND_END}`),
  new RegExp(String.raw`^no\s+(?:repos?|repositor(?:y|ies))\s*,\s*please$`),
  new RegExp(
    String.raw`^(?:please\s+)?(?:start|run|work)(?:\s+(?:this|the task|this request|a session))?\s+${EXECUTION_TARGET}${COMMAND_END}`
  ),
  new RegExp(
    String.raw`^(?:please\s+)?(?:avoid|do not|don't)\s+(?:cloning|checking\s+out)(?:\s+(?:anything|${REPOSITORY_OBJECT}))?${COMMAND_END}`
  ),
  new RegExp(
    String.raw`^(?:please\s+)?(?:do not|don't)\s+use\s+${REPOSITORY_OBJECT}${COMMAND_END}`
  ),
];

function statements(text: string): string[] {
  return text
    .replaceAll("’", "'")
    .toLowerCase()
    .split(/[\n.!?;]+/)
    .map((statement) =>
      statement
        .replace(/^\s*\[[^\]]+\]:\s*/, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean);
}

export function parseNoRepositoryIntent(text: string): NoRepositoryIntent {
  let foundExplicit = false;

  for (const statement of statements(text)) {
    if (NEGATED_PATTERNS.some((pattern) => pattern.test(statement))) {
      return "negated";
    }
    if (EXPLICIT_PATTERNS.some((pattern) => pattern.test(statement))) {
      foundExplicit = true;
    }
  }

  return foundExplicit ? "explicit" : "absent";
}
