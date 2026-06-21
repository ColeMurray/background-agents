import { describe, it, expect } from "vitest";
import {
  triggerSources,
  isValidCron,
  cronIntervalMinutes,
  isValidModel,
  isValidReasoningEffort,
  validateConditions,
  conditionRegistry,
  TRIGGER_TYPE_TO_SOURCE,
  DEFAULT_ENABLED_MODELS,
  DEFAULT_MODEL,
  type AutomationTriggerType,
} from "@open-inspect/shared";
import {
  automationTemplates,
  TEMPLATE_CATEGORIES,
  getTemplateById,
  getTemplatesForCategory,
  getVisibleCategories,
  resolveTemplateInitialValues,
} from "./automation-templates";

// Keep in sync with INSTRUCTIONS_MAX_LENGTH in automation-form.tsx /
// MAX_INSTRUCTIONS_LENGTH in control-plane routes/automations.ts.
const INSTRUCTIONS_MAX_LENGTH = 15000;
// Schedules must be at least this far apart (control-plane create validation).
const MIN_INTERVAL_MINUTES = 15;

const CATEGORY_IDS = new Set(TEMPLATE_CATEGORIES.map((c) => c.id));
const REPO_FIELDS = ["repoOwner", "repoName", "baseBranch"] as const;

// Maps each trigger type to the set of event types its source actually supports.
const eventTypesByTrigger = new Map<string, Set<string>>(
  triggerSources.map((s) => [s.triggerType, new Set(s.eventTypes.map((e) => e.eventType))])
);

describe("automation templates catalog", () => {
  it("has at least one template", () => {
    expect(automationTemplates.length).toBeGreaterThan(0);
  });

  it("has unique ids", () => {
    const ids = automationTemplates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has at least one Popular template", () => {
    expect(automationTemplates.some((t) => t.categories.includes("popular"))).toBe(true);
  });

  describe.each(automationTemplates.map((t) => [t.id, t] as const))("template %s", (_id, t) => {
    it("never prefills repository fields (AC-4)", () => {
      for (const field of REPO_FIELDS) {
        expect(t.prefill[field]).toBeUndefined();
      }
    });

    it("omits scheduleTz so the user's timezone default applies", () => {
      expect(t.prefill.scheduleTz).toBeUndefined();
    });

    it("has non-empty title, description, and instructions", () => {
      expect(t.title.trim().length).toBeGreaterThan(0);
      expect(t.description.trim().length).toBeGreaterThan(0);
      expect((t.prefill.instructions ?? "").trim().length).toBeGreaterThan(0);
    });

    it("keeps instructions within the 15,000 character cap", () => {
      expect((t.prefill.instructions ?? "").length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_LENGTH);
    });

    it("declares only known categories", () => {
      expect(t.categories.length).toBeGreaterThan(0);
      for (const category of t.categories) {
        expect(CATEGORY_IDS.has(category)).toBe(true);
      }
    });

    it("declares a supported primary output", () => {
      expect(["pr", "slack"]).toContain(t.primaryOutput);
    });

    const triggerType = t.prefill.triggerType;

    it("has a trigger type", () => {
      expect(triggerType).toBeDefined();
    });

    if (triggerType === "schedule") {
      it("schedule template has a valid cron of at least 15 minutes and no event type", () => {
        expect(t.prefill.scheduleCron).toBeDefined();
        expect(isValidCron(t.prefill.scheduleCron as string)).toBe(true);
        // All starter cadences are constant-interval (daily/weekly), so the
        // interval is computable and must clear the 15-minute floor.
        const interval = cronIntervalMinutes(t.prefill.scheduleCron as string);
        expect(interval).not.toBeNull();
        expect(interval as number).toBeGreaterThanOrEqual(MIN_INTERVAL_MINUTES);
        expect(t.prefill.eventType).toBeUndefined();
      });
    } else {
      it("event template has an event type in its source's catalog", () => {
        const allowed = eventTypesByTrigger.get(triggerType as string);
        expect(allowed).toBeDefined();
        expect(t.prefill.eventType).toBeDefined();
        expect(allowed?.has(t.prefill.eventType as string)).toBe(true);
      });
    }

    if (t.prefill.model) {
      it("suggests a valid model id", () => {
        expect(isValidModel(t.prefill.model as string)).toBe(true);
      });
    }

    if (t.prefill.reasoningEffort) {
      it("suggests a reasoning effort valid for the suggested/default model", () => {
        const model = (t.prefill.model as string) ?? DEFAULT_MODEL;
        expect(isValidReasoningEffort(model, t.prefill.reasoningEffort as string)).toBe(true);
      });
    }

    if (t.primaryOutput === "slack") {
      it("names a Slack channel in its instructions and carries a setup note", () => {
        expect(t.prefill.instructions ?? "").toMatch(/#[a-z0-9-]+/i);
        expect(t.setupNote).toBeTruthy();
      });
    }

    if (t.prefill.triggerConfig?.conditions?.length) {
      const conditions = t.prefill.triggerConfig.conditions;
      it("has trigger conditions valid for its source", () => {
        const source = TRIGGER_TYPE_TO_SOURCE[triggerType as AutomationTriggerType];
        expect(source).toBeDefined();
        const errors = validateConditions(
          conditions,
          source as NonNullable<typeof source>,
          conditionRegistry
        );
        expect(errors).toEqual([]);
      });
    }
  });
});

describe("getTemplateById", () => {
  it("finds a template by id", () => {
    const first = automationTemplates[0];
    expect(getTemplateById(first.id)).toBe(first);
  });

  it("returns undefined for an unknown id", () => {
    expect(getTemplateById("does-not-exist")).toBeUndefined();
  });
});

describe("getTemplatesForCategory", () => {
  it("returns only templates in that category, preserving catalog order", () => {
    const popular = getTemplatesForCategory("popular");
    expect(popular.length).toBeGreaterThan(0);
    expect(popular.every((t) => t.categories.includes("popular"))).toBe(true);
    const catalogIndices = popular.map((t) => automationTemplates.indexOf(t));
    expect(catalogIndices).toEqual([...catalogIndices].sort((a, b) => a - b));
  });
});

describe("getVisibleCategories", () => {
  it("includes only categories that have at least one template", () => {
    const visible = getVisibleCategories();
    expect(visible.length).toBeGreaterThan(0);
    for (const category of visible) {
      expect(getTemplatesForCategory(category.id).length).toBeGreaterThan(0);
    }
  });

  it("preserves the curated category order (a subsequence of TEMPLATE_CATEGORIES)", () => {
    const curated = TEMPLATE_CATEGORIES.map((c) => c.id);
    const visible = getVisibleCategories().map((c) => c.id);
    let cursor = 0;
    for (const id of curated) {
      if (visible[cursor] === id) cursor++;
    }
    expect(cursor).toBe(visible.length);
  });

  it("starts with Popular", () => {
    expect(getVisibleCategories()[0].id).toBe("popular");
  });
});

describe("resolveTemplateInitialValues", () => {
  it("keeps a suggested model that is enabled", () => {
    const result = resolveTemplateInitialValues({ model: "anthropic/claude-opus-4-8" }, [
      "anthropic/claude-opus-4-8",
      DEFAULT_MODEL,
    ]);
    expect(result.model).toBe("anthropic/claude-opus-4-8");
  });

  it("coerces an unenabled suggested model to the default when the default is enabled", () => {
    const result = resolveTemplateInitialValues({ model: "anthropic/claude-opus-4-8" }, [
      DEFAULT_MODEL,
    ]);
    expect(result.model).toBe(DEFAULT_MODEL);
  });

  it("coerces to the first enabled model when neither suggestion nor default is enabled", () => {
    const result = resolveTemplateInitialValues({ model: "anthropic/claude-opus-4-8" }, [
      "openai/gpt-5.5",
    ]);
    expect(result.model).toBe("openai/gpt-5.5");
  });

  it("omits the model when the template does not suggest one", () => {
    const result = resolveTemplateInitialValues({ name: "X" }, DEFAULT_ENABLED_MODELS as string[]);
    expect(result.model).toBeUndefined();
    expect(result.name).toBe("X");
  });

  it("drops a reasoning effort the resolved model does not support", () => {
    const result = resolveTemplateInitialValues(
      { model: "anthropic/claude-opus-4-8", reasoningEffort: "max" },
      ["openai/gpt-5.5"]
    );
    expect(result.model).toBe("openai/gpt-5.5");
    expect(result.reasoningEffort).toBeUndefined();
  });

  it("keeps a reasoning effort valid for the resolved model", () => {
    const result = resolveTemplateInitialValues(
      { model: "anthropic/claude-opus-4-8", reasoningEffort: "high" },
      ["anthropic/claude-opus-4-8"]
    );
    expect(result.reasoningEffort).toBe("high");
  });

  it("passes non-model fields through untouched", () => {
    const result = resolveTemplateInitialValues(
      { name: "Find bugs", triggerType: "schedule", scheduleCron: "0 9 * * *" },
      DEFAULT_ENABLED_MODELS as string[]
    );
    expect(result).toMatchObject({
      name: "Find bugs",
      triggerType: "schedule",
      scheduleCron: "0 9 * * *",
    });
  });

  it("resolves every catalog template to an enabled model", () => {
    for (const t of automationTemplates) {
      const result = resolveTemplateInitialValues(t.prefill, DEFAULT_ENABLED_MODELS as string[]);
      if (result.model !== undefined) {
        expect((DEFAULT_ENABLED_MODELS as readonly string[]).includes(result.model)).toBe(true);
      }
    }
  });
});
