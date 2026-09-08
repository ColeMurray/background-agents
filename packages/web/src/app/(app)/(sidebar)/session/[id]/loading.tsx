export default function SessionLoading() {
  return (
    <div className="flex h-full flex-col" role="status" aria-label="Loading session">
      <div className="h-14 animate-pulse border-b border-border bg-muted/30" />
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-6 py-8">
        <div className="h-20 animate-pulse rounded-lg bg-muted/50" />
        <div className="h-32 animate-pulse rounded-lg bg-muted/40" />
        <div className="h-24 animate-pulse rounded-lg bg-muted/30" />
      </div>
    </div>
  );
}
