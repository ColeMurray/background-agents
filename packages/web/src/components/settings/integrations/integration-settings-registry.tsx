"use client";

import type { ComponentType } from "react";
import { INTEGRATION_DEFINITIONS, type IntegrationId } from "@open-inspect/shared";
import { CodeServerIntegrationSettings } from "./code-server-integration-settings";
import { GitHubIntegrationSettings } from "./github-integration-settings";
import { LinearIntegrationSettings } from "./linear-integration-settings";
import { SlackIntegrationSettings } from "./slack-integration-settings";

export const integrationSettingsComponents: Partial<Record<IntegrationId, ComponentType>> = {
  github: GitHubIntegrationSettings,
  linear: LinearIntegrationSettings,
  "code-server": CodeServerIntegrationSettings,
  slack: SlackIntegrationSettings,
};

export const visibleIntegrationDefinitions = INTEGRATION_DEFINITIONS.filter(
  ({ id }) => id in integrationSettingsComponents
);
