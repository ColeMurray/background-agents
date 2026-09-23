"use client";

import { useCallback, useState, useMemo } from "react";
import { useRepos } from "@/hooks/use-repos";
import { useEnvironments } from "@/hooks/use-environments";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { reconcileProviderSelectionsForHarness } from "@open-inspect/shared/harnesses";
import { resolveHarnessModelSelection } from "@/lib/session-harness";
import { SUBSCRIPTION_PROVIDER_IDS } from "@open-inspect/shared/types/provider-accounts";
import { useProviderAccounts } from "@/hooks/use-provider-accounts";
import { ProviderAuthControls } from "@/components/provider-auth-controls";
import { setProviderSelection } from "@/lib/provider-selection";
import { FieldDescription } from "./automation-form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAutomationTargets } from "./use-automation-targets";
import { AutomationAgentFields } from "./automation-agent-fields";
import { AutomationTargetPicker } from "./automation-target-picker";
import { AutomationInstructionsField } from "./automation-instructions-field";
import {
  AutomationTriggerConfigurationFields,
  AutomationTriggerTypeField,
} from "./automation-trigger-fields";
import {
  createAutomationFormDraft,
  evaluateAutomationForm,
  requiresRepositoryContext,
  type AutomationAgentDraft,
  type AutomationFormValues,
} from "./automation-form-policy";

export type { AutomationFormValues } from "./automation-form-policy";

interface AutomationFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<AutomationFormValues>;
  onSubmit: (values: AutomationFormValues) => void;
  submitting: boolean;
}

export function AutomationForm({ mode, initialValues, onSubmit, submitting }: AutomationFormProps) {
  const { repos, loading: loadingRepos } = useRepos();
  const { environments, loading: loadingEnvironments } = useEnvironments();
  const { enabledModels, enabledModelOptions, loading: loadingModels } = useEnabledModels();
  const providerAccounts = useProviderAccounts();
  const initialDraft = useMemo(() => createAutomationFormDraft(initialValues), [initialValues]);
  const initialRepositories = useMemo(
    () => initialValues?.repositories ?? [],
    [initialValues?.repositories]
  );

  const [name, setName] = useState(initialDraft.name);
  const [providerSelections, setProviderSelections] = useState(initialDraft.providerSelections);
  const [agent, setAgent] = useState(initialDraft.agent);
  const [instructions, setInstructions] = useState(initialDraft.instructions);
  const [trigger, setTrigger] = useState(initialDraft.trigger);
  const repositoryRequired = requiresRepositoryContext(trigger.type);

  const isSchedule = trigger.type === "schedule";
  // Multi-repository selections are schedule-only (the server rejects them for
  // event triggers), so the mode toggle only exists there.
  const multiRepoAllowed = isSchedule;

  const targets = useAutomationTargets({
    initialRepositories,
    initialEnvironmentIds: initialValues?.environmentIds ?? [],
    multiRepoAllowed,
    repositoryRequired,
    repos,
  });
  const { selectedEnvironmentIds, buildRepositoriesPayload } = targets;

  // The model we display and submit, and whether it may be submitted. The
  // selector only lists enabled models the harness can run, so a disabled
  // default (blank create), a disabled saved model (edit), a disabled template
  // suggestion, or a model the harness cannot run is coerced to a listed one.
  // Until preferences load we can't know the enabled set, so the selection
  // stands and submit is blocked; when the harness can run none of the enabled
  // models the form says so and blocks too — keeping display, reasoning, and
  // the payload in agreement without relying on a post-load effect.
  const modelSelection = useMemo(
    () =>
      resolveHarnessModelSelection({
        harness: agent.harness,
        preference: { model: agent.model },
        enabledModels,
        enabledModelOptions,
        loading: loadingModels,
      }),
    [agent.harness, agent.model, enabledModelOptions, enabledModels, loadingModels]
  );
  const resolvedModel = modelSelection.model;
  const modelError =
    modelSelection.availability.status === "unavailable" ? modelSelection.availability.message : "";

  // A harness switch drops pins the new harness cannot honour, so the form
  // never offers to save a configuration the server would refuse.
  const handleAgentChange = useCallback((next: AutomationAgentDraft) => {
    setAgent(next);
    setProviderSelections((current) =>
      reconcileProviderSelectionsForHarness(next.harness, current)
    );
  }, []);

  const formEvaluation = evaluateAutomationForm({
    mode,
    originalTrigger: initialDraft.trigger,
    modelAvailability: modelSelection.availability,
    resolvedModel,
    draft: {
      name,
      instructions,
      providerSelections,
      agent,
      trigger,
    },
    targets: {
      repositories: buildRepositoriesPayload(),
      environmentIds: selectedEnvironmentIds,
    },
  });
  const conditionErrors =
    !formEvaluation.valid && formEvaluation.reason === "invalid-conditions"
      ? formEvaluation.conditionErrors
      : [];
  const eventTypeError =
    !formEvaluation.valid && formEvaluation.reason === "event-type-required"
      ? "Event type is required."
      : "";
  const slackChannelError =
    !formEvaluation.valid && formEvaluation.reason === "slack-channel-required"
      ? "Slack triggers require at least one Slack Channel condition."
      : "";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formEvaluation.valid) return;
    onSubmit(formEvaluation.values);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <AutomationTriggerTypeField mode={mode} value={trigger} onChange={setTrigger} />

      {/* Name */}
      <div>
        <label
          htmlFor="automation-name"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Name
        </label>
        <Input
          id="automation-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isSchedule ? "Daily code review" : "Review new PRs"}
          maxLength={200}
          required
        />
      </div>

      <AutomationTargetPicker
        targets={targets}
        repos={repos}
        environments={environments}
        loadingRepos={loadingRepos}
        loadingEnvironments={loadingEnvironments}
        multiTargetAllowed={multiRepoAllowed}
        repositoryRequired={repositoryRequired}
      />

      <AutomationAgentFields
        value={agent}
        resolvedModel={resolvedModel}
        enabledModelOptions={modelSelection.options}
        modelError={modelError}
        onChange={handleAgentChange}
      />

      <fieldset className="space-y-3 rounded-md border border-border-muted p-4">
        <legend className="px-1 text-sm font-medium text-foreground">
          Provider authentication
        </legend>
        <FieldDescription className="mb-3">
          Unpinned providers use defaults when each run starts. Pins are retained when the
          configured model changes and apply only to future sessions.
        </FieldDescription>
        {SUBSCRIPTION_PROVIDER_IDS.map((provider) => (
          <ProviderAuthControls
            key={provider}
            provider={provider}
            harness={agent.harness}
            accounts={providerAccounts.accounts}
            defaultValue={providerAccounts.defaults.find((item) => item.provider === provider)}
            value={providerSelections[provider]}
            policyLabel="Use defaults when each run starts"
            unattended
            disabled={submitting}
            onChange={(selection) =>
              setProviderSelections((current) => setProviderSelection(current, provider, selection))
            }
          />
        ))}
      </fieldset>

      <AutomationTriggerConfigurationFields
        key={trigger.type}
        mode={mode}
        value={trigger}
        onChange={setTrigger}
        eventTypeError={eventTypeError}
        slackChannelError={slackChannelError}
        conditionErrors={conditionErrors}
      />

      <AutomationInstructionsField
        value={instructions}
        triggerType={trigger.type}
        onChange={setInstructions}
      />

      {/* Submit */}
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={submitting || !formEvaluation.valid}>
          {submitting
            ? mode === "create"
              ? "Creating..."
              : "Saving..."
            : mode === "create"
              ? "Create Automation"
              : "Save Changes"}
        </Button>
      </div>
    </form>
  );
}
