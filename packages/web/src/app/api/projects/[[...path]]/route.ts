import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, POST, PATCH, PUT, DELETE } = settingsProxy(
  ({ path = [] }: { path?: string[] }, request) => {
    const query = new URLSearchParams();
    for (const key of ["status", "search", "mine", "teamId", "bucket", "cursor"]) {
      const value = request.nextUrl.searchParams.get(key);
      if (value !== null) query.set(key, value);
    }
    const suffix = query.size ? `?${query}` : "";
    return `/projects${path.length ? `/${path.map(encodeURIComponent).join("/")}` : ""}${suffix}`;
  },
  "project"
);
