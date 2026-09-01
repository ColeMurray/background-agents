import {
  DEFAULT_ENABLED_MODELS,
  MODEL_OPTIONS,
  MODEL_REASONING_CONFIG,
  normalizeValidModels,
} from "@open-inspect/shared/models";
import type { Environment } from "@open-inspect/shared/types/environments";
import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import { EnvironmentStore, toEnvironment } from "../db/environments";
import { ModelPreferencesStore } from "../db/model-preferences";
import { ModelProviderAccountStore } from "../db/model-provider-accounts";
import { ProviderDefaultStore } from "../db/provider-account-defaults";
import { SkillProfileStore } from "../db/skill-profiles";
import { SkillStore } from "../db/skills";
import type { Env } from "../types";
import { handleListRepos } from "./repos";
import {
  SCM_AGNOSTIC_EXTERNAL_USER_ROUTE,
  activeGlobal,
  defineRoutes,
  error,
  json,
  parsePattern,
  requirePermission,
  type Route,
  type UserRouteContext,
} from "./shared";

const EXTERNAL_V1_PATH = "/external/v1";
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const PRIVATE_NO_STORE = "private, no-store" as const;

interface ListQuery {
  limit: number;
  offset: number;
}

function hasOnlyQueryParams(request: Request, allowed: readonly string[]): boolean {
  const search = new URL(request.url).searchParams;
  return [...search.keys()].every(
    (key) => allowed.includes(key) && search.getAll(key).length === 1
  );
}

function listQuery(request: Request): ListQuery | Response {
  const search = new URL(request.url).searchParams;
  if (!hasOnlyQueryParams(request, ["limit", "offset"])) {
    return error("Invalid list query", 400);
  }
  const limitValue = search.get("limit");
  const offsetValue = search.get("offset");
  const limit = limitValue === null ? DEFAULT_LIST_LIMIT : Number(limitValue);
  const offset = offsetValue === null ? 0 : Number(offsetValue);
  if (
    (limitValue !== null && !/^\d+$/.test(limitValue)) ||
    (offsetValue !== null && !/^\d+$/.test(offsetValue)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(offset + limit)
  ) {
    return error("Invalid list query", 400);
  }
  return { limit, offset };
}

function page<T>(
  items: T[],
  query: ListQuery
): {
  items: T[];
  hasMore: boolean;
  continuationOffset?: number;
} {
  const values = items.slice(query.offset, query.offset + query.limit);
  const hasMore = query.offset + values.length < items.length;
  return {
    items: values,
    hasMore,
    ...(hasMore ? { continuationOffset: query.offset + values.length } : {}),
  };
}

function projectEnvironment({ channelAssociations: _channels, ...environment }: Environment) {
  return environment;
}

async function listRepositories(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const query = listQuery(request);
  if (query instanceof Response) return query;
  const response = await handleListRepos(request, env, match, ctx);
  if (!response.ok) return response;
  const result = (await response.json()) as { repos: EnrichedRepository[] };
  const repositories = page(
    result.repos.map(
      ({
        id,
        owner,
        name,
        fullName,
        description,
        private: isPrivate,
        defaultBranch,
        archived,
      }) => ({
        id,
        owner,
        name,
        fullName,
        description,
        private: isPrivate,
        defaultBranch,
        archived,
      })
    ),
    query
  );
  return json({
    repositories: repositories.items,
    hasMore: repositories.hasMore,
    ...(repositories.continuationOffset === undefined
      ? {}
      : { continuationOffset: repositories.continuationOffset }),
  });
}

async function listEnvironments(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const query = listQuery(request);
  if (query instanceof Response) return query;
  const store = new EnvironmentStore(ctx.db);
  const result = await store.list();
  const rows = page(result.environments, query);
  const repositories = await store.getRepositoriesForEnvironmentIds(rows.items.map(({ id }) => id));
  return json({
    environments: rows.items.map((row) =>
      projectEnvironment(toEnvironment(row, repositories.get(row.id) ?? []))
    ),
    hasMore: rows.hasMore,
    ...(rows.continuationOffset === undefined
      ? {}
      : { continuationOffset: rows.continuationOffset }),
  });
}

async function getEnvironment(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  if (!hasOnlyQueryParams(request, [])) return error("Invalid query", 400);
  const id = match.groups?.id;
  if (!id) return error("Environment ID required", 400);
  const store = new EnvironmentStore(ctx.db);
  const row = await store.getById(id);
  if (!row) return error("Environment not found", 404);
  return json({
    environment: projectEnvironment(
      toEnvironment(row, await store.getRepositoriesForEnvironment(id))
    ),
  });
}

async function listModels(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  if (!hasOnlyQueryParams(request, [])) return error("Invalid query", 400);
  const configured = await new ModelPreferencesStore(ctx.db).getEnabledModels();
  const normalized = configured ? normalizeValidModels(configured) : [];
  const enabled = new Set(normalized.length > 0 ? normalized : DEFAULT_ENABLED_MODELS);
  return json({
    models: MODEL_OPTIONS.flatMap(({ category, models }) =>
      models
        .filter(({ id }) => enabled.has(id))
        .map((model) => ({
          ...model,
          category,
          reasoning: MODEL_REASONING_CONFIG[model.id] ?? null,
        }))
    ),
  });
}

async function listSkills(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const query = listQuery(request);
  if (query instanceof Response) return query;
  const fetched = await new SkillStore(ctx.db).list({
    limit: query.offset + query.limit,
    cursor: null,
  });
  const profiles = ctx.authorization?.permissions.includes("skill_profiles.manage_own")
    ? await new SkillProfileStore(ctx.db).list(ctx.principal.userId)
    : [];
  const combinedPage = page([...fetched.skills, ...profiles], query);
  const hasMore = combinedPage.hasMore || fetched.hasMore;
  return json({
    skills: combinedPage.items.filter((item) => "currentRevisionId" in item),
    profiles: combinedPage.items.filter((item) => !("currentRevisionId" in item)),
    hasMore,
    ...(hasMore ? { continuationOffset: query.offset + combinedPage.items.length } : {}),
  });
}

async function listProviderAccounts(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const query = listQuery(request);
  if (query instanceof Response) return query;
  const [accounts, defaults] = await Promise.all([
    new ModelProviderAccountStore(ctx.db).list(),
    new ProviderDefaultStore(ctx.db).list(),
  ]);
  const defaultByProvider = new Map(defaults.map((value) => [value.provider, value]));
  const projected = accounts.map(({ id, provider, displayName, status }) => {
    const providerDefault = defaultByProvider.get(provider);
    return {
      id,
      provider,
      displayName,
      status,
      isDefault: providerDefault?.providerAccountId === id,
      unattendedMode:
        providerDefault?.providerAccountId === id ? providerDefault.unattendedMode : null,
    };
  });
  const accountsPage = page(projected, query);
  return json({
    accounts: accountsPage.items,
    hasMore: accountsPage.hasMore,
    ...(accountsPage.continuationOffset === undefined
      ? {}
      : { continuationOffset: accountsPage.continuationOffset }),
  });
}

export const externalDiscoveryRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_EXTERNAL_USER_ROUTE, [
  {
    method: "GET",
    pattern: parsePattern(`${EXTERNAL_V1_PATH}/repositories`),
    authorization: requirePermission("repositories.read", { service: "deny" }),
    cacheControl: PRIVATE_NO_STORE,
    handler: listRepositories,
  },
  {
    method: "GET",
    pattern: parsePattern(`${EXTERNAL_V1_PATH}/environments`),
    authorization: requirePermission("environments.read", { service: "deny" }),
    cacheControl: PRIVATE_NO_STORE,
    handler: listEnvironments,
  },
  {
    method: "GET",
    pattern: parsePattern(`${EXTERNAL_V1_PATH}/environments/:id`),
    authorization: requirePermission("environments.read", { service: "deny" }),
    cacheControl: PRIVATE_NO_STORE,
    handler: getEnvironment,
  },
  {
    method: "GET",
    pattern: parsePattern(`${EXTERNAL_V1_PATH}/models`),
    authorization: activeGlobal(),
    cacheControl: PRIVATE_NO_STORE,
    handler: listModels,
  },
  {
    method: "GET",
    pattern: parsePattern(`${EXTERNAL_V1_PATH}/skills`),
    authorization: requirePermission("skills.read", { service: "deny" }),
    cacheControl: PRIVATE_NO_STORE,
    handler: listSkills,
  },
  {
    method: "GET",
    pattern: parsePattern(`${EXTERNAL_V1_PATH}/provider-accounts`),
    authorization: requirePermission("provider_accounts.read", { service: "deny" }),
    cacheControl: PRIVATE_NO_STORE,
    handler: listProviderAccounts,
  },
]);
