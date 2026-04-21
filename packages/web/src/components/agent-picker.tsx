"use client";

import { useState } from "react";
import type { AvailableAgent } from "@open-inspect/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { CheckIcon, ChevronDownIcon } from "@/components/ui/icons";

interface AgentPickerProps {
  selectedAgent: string;
  onSelect: (agent: string) => void;
  availableAgents: AvailableAgent[];
  hasFetchedAgents: boolean;
  disabled?: boolean;
}

export function AgentPicker({
  selectedAgent,
  onSelect,
  availableAgents,
  hasFetchedAgents,
  disabled = false,
}: AgentPickerProps) {
  const [open, setOpen] = useState(false);
  const agents =
    availableAgents.length > 0
      ? availableAgents
      : [{ name: "build", description: "Default agent" }];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex items-center gap-2 self-start text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition sm:self-auto"
        >
          <span className="text-secondary-foreground">Agent</span>
          <span className="max-w-[10rem] truncate text-foreground">{selectedAgent}</span>
          <ChevronDownIcon className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={8} className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Search agents..." />
          <CommandList>
            {!hasFetchedAgents && (
              <div className="border-b border-border-muted px-3 py-2 text-xs text-muted-foreground">
                Agents will be fetched after the sandbox is running.
              </div>
            )}
            <CommandEmpty>No agents found.</CommandEmpty>
            <CommandGroup>
              {agents.map((agent) => (
                <CommandItem
                  key={agent.name}
                  value={`${agent.name} ${agent.description ?? ""}`}
                  onSelect={() => {
                    onSelect(agent.name);
                    setOpen(false);
                  }}
                  className="items-start"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium">{agent.name}</span>
                    {agent.description && (
                      <span className="truncate text-xs text-secondary-foreground">
                        {agent.description}
                      </span>
                    )}
                  </div>
                  {selectedAgent === agent.name && (
                    <CheckIcon className="mt-0.5 h-4 w-4 text-accent" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
