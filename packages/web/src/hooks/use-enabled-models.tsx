"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import useSWR from "swr";
import { z } from "zod";
import {
  MODEL_OPTIONS,
  DEFAULT_ENABLED_MODELS,
  applyModelPreferenceChanges,
  isValidModel,
  normalizeModelId,
  normalizeValidModels,
  type ModelCategory,
  type ModelPreferenceChange,
  type ValidModel,
} from "@open-inspect/shared/models";
import { browserApiFetch } from "@/lib/browser-api-fetch";

export const MODEL_PREFERENCES_KEY = "/api/model-preferences";

const canonicalModelSchema = z.custom<ValidModel>(
  (value) => typeof value === "string" && isValidModel(value) && normalizeModelId(value) === value
);
const modelPreferencesSchema = z.object({
  enabledModels: z.array(canonicalModelSchema).nonempty(),
});
type ModelPreferencesResponse = z.infer<typeof modelPreferencesSchema>;

type PendingChange = readonly ModelPreferenceChange[];

interface EnabledModelsContextValue {
  enabledModels: string[];
  enabledModelOptions: ModelCategory[];
  loading: boolean;
  error: unknown;
  saving: boolean;
  updateModels: (changes: readonly ModelPreferenceChange[]) => Promise<void>;
}

const EnabledModelsContext = createContext<EnabledModelsContextValue | null>(null);

function responseError(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  return typeof body.error === "string" ? body.error : null;
}

export function ModelPreferencesProvider({ children }: { children: ReactNode }) {
  const { data, error, isLoading, mutate } =
    useSWR<ModelPreferencesResponse>(MODEL_PREFERENCES_KEY);
  const [pending, setPending] = useState<PendingChange[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const confirmedModels = useMemo<ValidModel[]>(() => {
    if (isLoading) return [];
    const normalized = normalizeValidModels(
      Array.isArray(data?.enabledModels) ? data.enabledModels : []
    );
    return normalized.length > 0 ? normalized : DEFAULT_ENABLED_MODELS;
  }, [data?.enabledModels, isLoading]);

  const enabledModels = useMemo(
    () =>
      pending.reduce(
        (models, changes) => applyModelPreferenceChanges(models, changes),
        confirmedModels
      ),
    [confirmedModels, pending]
  );

  const enabledModelOptions = useMemo(() => {
    const enabledSet = new Set(enabledModels);
    return MODEL_OPTIONS.map((group) => ({
      ...group,
      models: group.models.filter((model) => enabledSet.has(model.id)),
    })).filter((group) => group.models.length > 0);
  }, [enabledModels]);

  const updateModels = useCallback(
    (changes: readonly ModelPreferenceChange[]): Promise<void> => {
      if (isLoading || error) {
        return Promise.reject(new Error("Model preferences must load before saving"));
      }

      const operation: PendingChange = [...changes];
      setPending((current) => [...current, operation]);

      const request = queue.current.then(async () => {
        try {
          const res = await browserApiFetch(MODEL_PREFERENCES_KEY, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ changes: operation }),
          });
          const body: unknown = await res.json().catch(() => null);
          if (!res.ok) throw new Error(responseError(body) ?? "Failed to save preferences");
          const parsed = modelPreferencesSchema.safeParse(body);
          if (!parsed.success) throw new Error("Invalid model preferences response");
          await mutate(parsed.data, { revalidate: false });
        } catch (requestError) {
          setPending((current) => current.filter((candidate) => candidate !== operation));
          await mutate().catch(() => undefined);
          throw requestError;
        }
        setPending((current) => current.filter((candidate) => candidate !== operation));
      });

      queue.current = request.catch(() => undefined);
      return request;
    },
    [error, isLoading, mutate]
  );

  const value = useMemo<EnabledModelsContextValue>(
    () => ({
      enabledModels,
      enabledModelOptions,
      loading: isLoading,
      error,
      saving: pending.length > 0,
      updateModels,
    }),
    [enabledModelOptions, enabledModels, error, isLoading, pending.length, updateModels]
  );

  return <EnabledModelsContext.Provider value={value}>{children}</EnabledModelsContext.Provider>;
}

export function useEnabledModels(): EnabledModelsContextValue {
  const value = useContext(EnabledModelsContext);
  if (!value) throw new Error("useEnabledModels must be used within ModelPreferencesProvider");
  return value;
}
