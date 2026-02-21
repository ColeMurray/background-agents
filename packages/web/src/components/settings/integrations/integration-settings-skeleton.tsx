export function IntegrationSettingsSkeleton() {
  return (
    <div className="animate-pulse">
      {/* Title + description */}
      <div className="h-6 w-36 bg-muted rounded mb-2" />
      <div className="h-4 w-72 bg-muted rounded mb-6" />

      {/* Section: Connection */}
      <div className="border border-border-muted rounded-md p-5 mb-5">
        <div className="h-3 w-24 bg-muted rounded mb-2" />
        <div className="h-4 w-56 bg-muted rounded mb-4" />
        <div className="h-4 w-full bg-muted rounded" />
      </div>

      {/* Section: Defaults & Scope */}
      <div className="border border-border-muted rounded-md p-5 mb-5">
        <div className="h-3 w-28 bg-muted rounded mb-2" />
        <div className="h-4 w-64 bg-muted rounded mb-4" />
        <div className="h-10 w-full bg-muted rounded mb-3" />
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="h-10 bg-muted rounded" />
          <div className="h-10 bg-muted rounded" />
        </div>
        <div className="h-9 w-20 bg-muted rounded" />
      </div>

      {/* Section: Repository Overrides */}
      <div className="border border-border-muted rounded-md p-5">
        <div className="h-3 w-40 bg-muted rounded mb-2" />
        <div className="h-4 w-72 bg-muted rounded mb-4" />
        <div className="h-4 w-full bg-muted rounded mb-3" />
        <div className="flex gap-2">
          <div className="h-10 flex-1 bg-muted rounded" />
          <div className="h-10 w-28 bg-muted rounded" />
        </div>
      </div>
    </div>
  );
}
