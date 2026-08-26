"use client";

import { useState } from "react";
import { Profiles } from "./profiles";
import { SkillsCatalog } from "./skills-catalog";

type View = "skills" | "profiles";

export function SkillsSettings() {
  const [view, setView] = useState<View>("skills");
  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-foreground">Skills</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Control the managed capabilities installed into new sessions.
        </p>
      </div>
      <div className="mb-6 flex border-b border-border-muted">
        {(["skills", "profiles"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setView(item)}
            className={`border-b-2 px-4 py-2 text-sm transition ${view === item ? "border-accent text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {item === "skills" ? "Shared skills" : "My profiles"}
          </button>
        ))}
      </div>
      {view === "skills" ? <SkillsCatalog /> : <Profiles />}
    </div>
  );
}
