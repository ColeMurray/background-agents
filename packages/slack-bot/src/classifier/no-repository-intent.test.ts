import { describe, expect, it } from "vitest";
import { parseNoRepositoryIntent, type NoRepositoryIntent } from "./no-repository-intent";

describe("parseNoRepositoryIntent", () => {
  it.each<[string, NoRepositoryIntent]>([
    ["Use no repository and research this topic", "explicit"],
    ["Choose no repo", "explicit"],
    ["Select no repositories", "explicit"],
    ["I want no repository", "explicit"],
    ["I need no repo", "explicit"],
    ["I don't need a repository", "explicit"],
    ["No repository is needed for this request", "explicit"],
    ["Repository not needed", "explicit"],
    ["Please no repo", "explicit"],
    ["No repository, please", "explicit"],
    ["Start without cloning a repository and research this", "explicit"],
    ["Please avoid cloning anything", "explicit"],
    ["Work without checking out code", "explicit"],
    ["Run in an empty sandbox", "explicit"],
    ["Work repository-less for this request", "explicit"],
    ["[Alice]: Use no repository", "explicit"],
    ["Fix this first.\nUse an empty sandbox", "explicit"],
    ["Do not work without a repository", "negated"],
    ["This must not run without cloning", "negated"],
    ["Do not use an empty sandbox", "negated"],
    ["Do not choose no repository", "negated"],
    ["Don't start repository-less", "negated"],
    ["Shouldn't run in an empty sandbox", "negated"],
    ["[Alice]: Do not use an empty sandbox", "negated"],
    ["Use no repository. Do not use an empty sandbox", "negated"],
    ["don't use Jest", "absent"],
    ["work without using lodash", "absent"],
    ["Fix the no repository picker", "absent"],
    ["Fix session creation with no repository", "absent"],
    ['Document the "use no repository" option', "absent"],
    ["Rename repository-not-needed-label", "absent"],
    ["Research authentication options", "absent"],
    ["Use Jest without lodash", "absent"],
    ["", "absent"],
  ])("parses %j as %s", (text, expected) => {
    expect(parseNoRepositoryIntent(text)).toBe(expected);
  });
});
