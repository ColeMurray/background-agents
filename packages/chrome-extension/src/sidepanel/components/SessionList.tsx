import { useState, useEffect } from "react";
import { listSessions } from "@/lib/api";
import { Button } from "@/components/ui/button";
import type { Session } from "@open-inspect/shared";

interface SessionListProps {
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
}

export function SessionList({ onSelectSession, onNewSession }: SessionListProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        setIsLoading(true);
        const data = await listSessions({ limit: 50, excludeStatus: "archived" });
        setSessions(data.sessions);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load sessions");
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* toolbar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-ash-200">
        <h2 className="text-sm font-semibold text-ash-900 font-clash">Sessions</h2>
        <Button variant="rebolt-primary" size="xs" onClick={onNewSession} className="gap-1.5">
          <PlusIcon />
          New
        </Button>
      </div>

      {/* list */}
      <div className="flex-1 overflow-y-auto scrollbar-none">
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-ash-300 border-t-rebolt-500" />
          </div>
        )}

        {error && (
          <div className="px-4 py-3 m-3 bg-lava-100 border border-lava-200 rounded-lg">
            <p className="text-sm text-lava-700">{error}</p>
          </div>
        )}

        {!isLoading && !error && sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <p className="text-sm text-ash-500 mb-3">No sessions yet</p>
            <Button variant="link" size="xs" onClick={onNewSession}>
              Create your first session
            </Button>
          </div>
        )}

        {!isLoading &&
          sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              onClick={() => onSelectSession(session.id)}
            />
          ))}
      </div>
    </div>
  );
}

interface SessionItemProps {
  session: Session;
  onClick: () => void;
}

function SessionItem({ session, onClick }: SessionItemProps) {
  const statusColors: Record<string, string> = {
    active: "bg-mint-400",
    created: "bg-honey-400",
    completed: "bg-ash-400",
    archived: "bg-ash-300",
  };

  const timeAgo = formatTimeAgo(session.updatedAt);

  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={onClick}
      className="w-full items-start gap-3 text-left border-b border-ash-200/50 h-auto py-3 px-4"
    >
      <div
        className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${statusColors[session.status] || "bg-ash-300"}`}
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-ash-900 truncate">
          {session.title || `${session.repoOwner}/${session.repoName}`}
        </p>
        <p className="text-xs text-ash-500 mt-0.5">
          {session.repoOwner}/{session.repoName} · {timeAgo}
        </p>
      </div>
      <ChevronRightIcon />
    </Button>
  );
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function PlusIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      className="w-4 h-4 text-ash-400 flex-shrink-0 mt-0.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
