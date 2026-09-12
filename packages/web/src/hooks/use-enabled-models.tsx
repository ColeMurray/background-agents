"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
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
import { useAuthSession } from "@/lib/auth-session";

export const MODEL_PREFERENCES_KEY = "/api/model-preferences";
const INITIAL_MODEL_PREFERENCES_REVISION = 0;

export function getModelPreferencesKey(
  identity: string
): `/api/model-preferences?identity=${string}` {
  return `${MODEL_PREFERENCES_KEY}?identity=${encodeURIComponent(identity)}`;
}

const canonicalModelSchema = z.custom<ValidModel>(
  (value) => typeof value === "string" && isValidModel(value) && normalizeModelId(value) === value
);
const modelPreferencesSchema = z.object({
  enabledModels: z.array(canonicalModelSchema).nonempty(),
  revision: z.number().int().nonnegative(),
});
type ModelPreferencesResponse = z.infer<typeof modelPreferencesSchema>;

type PendingChange = readonly ModelPreferenceChange[];

interface ProviderLifetime {
  identity: string;
  abortController: AbortController;
}

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

function applyValidChanges(
  models: readonly ValidModel[],
  operations: readonly PendingChange[]
): ValidModel[] {
  return operations.reduce(
    (current, changes) => {
      const next = applyModelPreferenceChanges(current, changes);
      return next.length > 0 ? next : current;
    },
    [...models]
  );
}

function rebasePending(
  models: readonly ValidModel[],
  operations: PendingChange[]
): PendingChange[] {
  let current = [...models];
  return operations.filter((changes) => {
    const next = applyModelPreferenceChanges(current, changes);
    if (next.length === 0) return false;
    current = next;
    return true;
  });
}

export function AuthenticatedModelPreferencesProvider({ children }: { children: ReactNode }) {
  const session = useAuthSession();
  if (session.status !== "authenticated") return null;
  return (
    <ModelPreferencesProvider key={session.data.user.id} identity={session.data.user.id}>
      {children}
    </ModelPreferencesProvider>
  );
}

export function ModelPreferencesProvider({
  children,
  identity,
}: {
  children: ReactNode;
  identity: string;
}) {
  const cacheKey = getModelPreferencesKey(identity);
  const { data, error, isLoading, mutate } = useSWR<ModelPreferencesResponse>(cacheKey);
  const [pending, setPending] = useState<PendingChange[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const lifetime = useRef<ProviderLifetime | null>(null);
  const confirmed = useRef<ModelPreferencesResponse>({
    enabledModels: DEFAULT_ENABLED_MODELS,
    revision: INITIAL_MODEL_PREFERENCES_REVISION,
  });

  useLayoutEffect(() => {
    const current: ProviderLifetime = {
      identity,
      abortController: new AbortController(),
    };
    lifetime.current = current;
    return () => {
      if (lifetime.current === current) lifetime.current = null;
      current.abortController.abort();
    };
  }, [identity]);

  const confirmedModels = useMemo<ValidModel[]>(() => {
    if (isLoading) return [];
    const snapshot = data && data.revision >= confirmed.current.revision ? data : confirmed.current;
    const normalized = normalizeValidModels(snapshot.enabledModels);
    return normalized.length > 0 ? normalized : DEFAULT_ENABLED_MODELS;
  }, [data, isLoading]);

  useLayoutEffect(() => {
    if (!data || data.revision < confirmed.current.revision) return;
    confirmed.current = { enabledModels: confirmedModels, revision: data.revision };
  }, [confirmedModels, data]);

  const enabledModels = useMemo(
    () => applyValidChanges(confirmedModels, pending),
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

      const owner = lifetime.current;
      if (!owner || owner.identity !== identity) return Promise.resolve();
      const isCurrent = () => lifetime.current === owner;
      const operation: PendingChange = [...changes];
      setPending((current) => [...current, operation]);

      const request = queue.current.then(async () => {
        if (!isCurrent()) return;
        if (applyModelPreferenceChanges(confirmed.current.enabledModels, operation).length === 0) {
          setPending((current) =>
            rebasePending(
              confirmed.current.enabledModels,
              current.filter((candidate) => candidate !== operation)
            )
          );
          throw new Error("At least one model must be enabled");
        }
        try {
          const res = await browserApiFetch(MODEL_PREFERENCES_KEY, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ changes: operation }),
            signal: owner.abortController.signal,
          });
          if (!isCurrent()) return;
          const body: unknown = await res.json().catch(() => null);
          if (!res.ok) throw new Error(responseError(body) ?? "Failed to save preferences");
          const parsed = modelPreferencesSchema.safeParse(body);
          if (!parsed.success) throw new Error("Invalid model preferences response");
          if (!isCurrent()) return;
          const accepted = await mutate(
            (current) =>
              !current || parsed.data.revision >= current.revision ? parsed.data : current,
            { revalidate: false }
          );
          if (accepted && accepted.revision >= confirmed.current.revision) {
            confirmed.current = accepted;
          }
        } catch (requestError) {
          if (!isCurrent()) return;
          const refreshed = await mutate().catch(() => undefined);
          if (refreshed && refreshed.revision >= confirmed.current.revision) {
            confirmed.current = refreshed;
          }
          setPending((current) =>
            rebasePending(
              confirmed.current.enabledModels,
              current.filter((candidate) => candidate !== operation)
            )
          );
          throw requestError;
        }
        if (isCurrent()) {
          setPending((current) =>
            rebasePending(
              confirmed.current.enabledModels,
              current.filter((candidate) => candidate !== operation)
            )
          );
        }
      });

      queue.current = request.catch(() => undefined);
      return request;
    },
    [error, identity, isLoading, mutate]
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
