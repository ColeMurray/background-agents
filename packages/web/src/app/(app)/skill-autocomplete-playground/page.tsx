"use client";

import { useRef, useState } from "react";
import { PromptSkillTextarea } from "@/components/prompt-skill-autocomplete";
import type { PromptSkillSuggestion } from "@/lib/prompt-skill-completion";

const PLAYGROUND_SKILLS: PromptSkillSuggestion[] = [
  {
    skillId: "review-pr",
    name: "review-pr",
    description: "Inspect a pull request for bugs, regressions, and missing tests.",
  },
  {
    skillId: "release-notes",
    name: "release-notes",
    description: "Turn merged work into concise, customer-facing release notes.",
  },
  {
    skillId: "research",
    name: "research",
    description: "Trace current behavior and produce an evidence-backed research document.",
  },
  {
    skillId: "visual-verification",
    name: "visual-verification",
    description: "Verify user-interface changes and capture visual evidence.",
  },
  {
    skillId: "record-video",
    name: "record-video",
    description: "Record a focused browser interaction for review.",
  },
];

export default function SkillAutocompletePlayground() {
  const [prompt, setPrompt] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  return (
    <main className="min-h-screen bg-background px-5 py-10 text-foreground sm:px-8 lg:py-16">
      <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)] lg:items-start">
        <section>
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-accent">
            Interaction playground
          </p>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">
            Reference a managed skill without leaving your prompt.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
            Type <code className="text-foreground">$</code> or{" "}
            <code className="text-foreground">/</code> after a space, then keep typing to filter.
            The selected reference is inserted as plain text.
          </p>

          <form
            className="mt-10"
            onSubmit={(event) => {
              event.preventDefault();
              if (prompt.trim()) setSubmitted(prompt);
            }}
          >
            <div className="border border-border bg-input shadow-2xl shadow-black/10">
              <div className="relative">
                <PromptSkillTextarea
                  ref={inputRef}
                  value={prompt}
                  suggestions={{ status: "ready", skills: PLAYGROUND_SKILLS }}
                  onValueChange={(value) => {
                    setPrompt(value);
                    setSubmitted(null);
                  }}
                  direction="up"
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (event.metaKey || event.ctrlKey) &&
                      !event.shiftKey &&
                      !event.altKey
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  data-testid="skill-playground-input"
                  autoComplete="off"
                  rows={7}
                  placeholder="Try: Use $research to trace how sessions are created"
                  className="w-full resize-none bg-transparent px-5 py-5 text-base leading-7 outline-none placeholder:text-secondary-foreground sm:px-6 sm:py-6"
                />
              </div>
              <div className="flex items-center justify-between gap-4 border-t border-border-muted px-5 py-3 sm:px-6">
                <span className="text-xs text-muted-foreground">
                  Arrow keys to navigate | Enter or Tab to complete | Esc to close
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setPrompt("");
                      setSubmitted(null);
                      inputRef.current?.focus();
                    }}
                    className="px-3 py-2 text-sm text-muted-foreground transition hover:text-foreground"
                  >
                    Reset
                  </button>
                  <button
                    type="submit"
                    disabled={!prompt.trim()}
                    className="bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    Submit
                  </button>
                </div>
              </div>
            </div>
          </form>

          {submitted && (
            <div className="mt-5 border-l-2 border-accent bg-accent-muted px-4 py-3" role="status">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Submitted as plain text
              </p>
              <p className="mt-1 whitespace-pre-wrap font-mono text-sm">{submitted}</p>
            </div>
          )}
        </section>

        <aside className="border border-border-muted bg-card p-5 sm:p-6">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-semibold">Available skills</h2>
            <span className="font-mono text-xs text-muted-foreground">
              {PLAYGROUND_SKILLS.length} pinned
            </span>
          </div>
          <div className="mt-5 divide-y divide-border-muted border-y border-border-muted">
            {PLAYGROUND_SKILLS.map((skill) => (
              <div key={skill.skillId} className="py-4">
                <p className="font-mono text-sm text-foreground">${skill.name}</p>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">{skill.description}</p>
              </div>
            ))}
          </div>
          <p className="mt-5 text-xs leading-5 text-muted-foreground">
            This page uses the production autocomplete component. It does not call OpenCode or
            modify session skill selection.
          </p>
        </aside>
      </div>
    </main>
  );
}
