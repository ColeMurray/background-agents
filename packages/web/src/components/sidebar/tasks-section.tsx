"use client";

import type { Task } from "@/types/session";
import { ClockIcon, CheckCircleIcon, EmptyCircleIcon } from "@/components/ui/icons";

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
          task.status === "completed" ? "text-secondary-foreground line-through" : "text-foreground"
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
          <ClockIcon className="w-4 h-4 text-accent animate-pulse" />
        </span>
      );
    case "completed":
      return (
        <span className="mt-0.5 flex-shrink-0">
          <CheckCircleIcon className="w-4 h-4 text-success" />
        </span>
      );
    case "pending":
    default:
      return (
        <span className="mt-0.5 flex-shrink-0">
          <EmptyCircleIcon className="w-4 h-4 text-secondary-foreground" />
        </span>
      );
  }
}
