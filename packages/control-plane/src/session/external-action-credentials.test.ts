import { describe, expect, it } from "vitest";
import {
  EXTERNAL_ACTION_PROVIDERS,
  parseExternalActionProviders,
  providerAuthorizationHeader,
} from "./external-action-credentials";

describe("the deployment's provider list", () => {
  it("is empty when the deployment named nothing", () => {
    expect(parseExternalActionProviders(undefined)).toEqual([]);
    expect(parseExternalActionProviders("")).toEqual([]);
  });

  it("names the providers it may publish through", () => {
    expect(parseExternalActionProviders("github, slack")).toEqual(["github", "slack"]);
  });

  it("normalizes the names and drops the duplicates", () => {
    expect(parseExternalActionProviders(" GitHub , github ,SLACK ")).toEqual(["github", "slack"]);
  });

  it("refuses a name it does not know rather than ignoring it", () => {
    expect(() => parseExternalActionProviders("github, gitea")).toThrow(
      /Unknown external action provider: gitea/
    );
  });

  it("knows only the four credential-closed providers", () => {
    expect(EXTERNAL_ACTION_PROVIDERS).toEqual(["github", "gitlab", "slack", "linear"]);
  });
});

describe("the provider authorization header", () => {
  it("carries the token the way each provider expects it", () => {
    expect(providerAuthorizationHeader("github", "ghs_token")).toEqual({
      authorization: "Bearer ghs_token",
    });
    expect(providerAuthorizationHeader("slack", "xoxb_token")).toEqual({
      authorization: "Bearer xoxb_token",
    });
    // Linear takes the key itself.
    expect(providerAuthorizationHeader("linear", "lin_api_key")).toEqual({
      authorization: "lin_api_key",
    });
  });
});
