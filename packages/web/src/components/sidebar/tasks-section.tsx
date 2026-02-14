"use client";

import type { Task } from "@/types/session";

interface TasksSectionProps {
  tasks: Task[];
}

export function TasksSection({ tasks }: TasksSectionProps) {
  if (tasks.length === 0) return null;

  return (
    <div className="space-y-2">
      {tasks.map((task, index) => (
        <TaskItem key={`${task.content}-${index}`} task={task} />
      ))}
    </div>
  );
}

function TaskItem({ task }: { task: Task }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <TaskStatusIcon status={task.status} />
      <span
        className={`flex-1 ${
          task.status === "completed" ? "text-ash-400 line-through" : "text-ash-900"
        }`}
      >
        {task.status === "in_progress" && task.activeForm ? task.activeForm : task.content}
      </span>
    </div>
  );
}

function TaskStatusIcon({ status }: { status: Task["status"] }) {
  switch (status) {
    case "in_progress":
      return (
        <span className="mt-0.5 flex-shrink-0">
          <ClockIcon className="w-4 h-4 text-rebolt-500 animate-pulse" />
        </span>
      );
    case "completed":
      return (
        <span className="mt-0.5 flex-shrink-0">
          <CheckCircleIcon className="w-4 h-4 text-mint-500" />
        </span>
      );
    case "pending":
    default:
      return (
        <span className="mt-0.5 flex-shrink-0">
          <EmptyCircleIcon className="w-4 h-4 text-ash-400" />
        </span>
      );
  }
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" strokeWidth={2} />
      <path strokeLinecap="round" strokeWidth={2} d="M12 6v6l4 2" />
    </svg>
  );
}

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function EmptyCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" strokeWidth={2} />
    </svg>
  );
}
