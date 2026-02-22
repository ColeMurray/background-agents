import { describe, expect, it } from "vitest";
import { COMPOSER_COMMANDS } from "./composer-commands";
import {
  filterComposerCommands,
  isLatestAutocompleteResult,
  nextAutocompleteRequestVersion,
} from "./composer-autocomplete";
import { appendTemplateToComposer, replaceActiveSlashToken } from "./composer-insert";
import { getSlashTokenContext } from "./composer-slash-grammar";

describe("getSlashTokenContext", () => {
  it("matches slash token at start of composer", () => {
    const context = getSlashTokenContext("/rev", 4);
    expect(context).toEqual({ start: 0, end: 4, query: "rev", token: "/rev" });
  });

  it("matches slash token after opening punctuation", () => {
    const context = getSlashTokenContext("Please run (/rev)", 16);
    expect(context).toEqual({ start: 12, end: 16, query: "rev", token: "/rev" });
  });

  it("ignores URL and path-like slashes", () => {
    expect(getSlashTokenContext("https://example.com", 8)).toBeNull();
    expect(getSlashTokenContext("src/foo/bar", 7)).toBeNull();
  });
});

describe("composer insert helpers", () => {
  it("replaces only the active slash token", () => {
    const context = getSlashTokenContext("please run /rev now", 15);
    expect(context).not.toBeNull();

    const result = replaceActiveSlashToken({
      text: "please run /rev now",
      context: context!,
      template: "Review these changes for regressions.",
    });

    expect(result.text).toBe("please run Review these changes for regressions. now");
    expect(result.caretIndex).toBe(48);
  });

  it("appends template with spacing when prompt has existing content", () => {
    const result = appendTemplateToComposer({ text: "Current draft", template: "Next step" });
    expect(result.text).toBe("Current draft\n\nNext step");
    expect(result.caretIndex).toBe(result.text.length);
  });
});

describe("composer autocomplete helpers", () => {
  it("filters and ranks command matches", () => {
    const matches = filterComposerCommands(COMPOSER_COMMANDS, "pl");
    expect(matches[0]?.command).toBe("plan");
  });

  it("tracks latest async request version", () => {
    const v1 = nextAutocompleteRequestVersion(0);
    const v2 = nextAutocompleteRequestVersion(v1);
    expect(isLatestAutocompleteResult(v2, v2)).toBe(true);
    expect(isLatestAutocompleteResult(v1, v2)).toBe(false);
  });
});
