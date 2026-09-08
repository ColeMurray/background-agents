import type { ResolvedSkill } from "@open-inspect/shared/types/skills";

export type PromptSkillSuggestion = Pick<ResolvedSkill, "skillId" | "name" | "description">;
export type PromptSkillSuggestionSource =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; skills: readonly PromptSkillSuggestion[] };

export type ActiveSkillCompletion = {
  trigger: "/" | "$";
  query: string;
  start: number;
  end: number;
};

const SKILL_CHARACTER = /^[a-z0-9-]$/i;

function isSkillCharacter(character: string | undefined): boolean {
  return character !== undefined && SKILL_CHARACTER.test(character);
}

export function findActiveSkillCompletion(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null
): ActiveSkillCompletion | null {
  if (selectionStart === null || selectionEnd === null || selectionStart !== selectionEnd)
    return null;

  let queryStart = selectionStart;
  while (queryStart > 0 && isSkillCharacter(value[queryStart - 1])) queryStart--;

  const triggerIndex = queryStart - 1;
  const trigger = value[triggerIndex];
  if (trigger !== "/" && trigger !== "$") return null;
  if (triggerIndex > 0 && !/\s/.test(value[triggerIndex - 1])) return null;

  let tokenEnd = selectionStart;
  while (tokenEnd < value.length && isSkillCharacter(value[tokenEnd])) tokenEnd++;

  return {
    trigger,
    query: value.slice(queryStart, selectionStart).toLowerCase(),
    start: triggerIndex,
    end: tokenEnd,
  };
}

export function filterSkillSuggestions(
  skills: readonly PromptSkillSuggestion[],
  completion: ActiveSkillCompletion | null
): PromptSkillSuggestion[] {
  if (!completion) return [];
  return skills.filter((skill) => skill.name.toLowerCase().startsWith(completion.query));
}

export function applySkillCompletion(
  value: string,
  completion: ActiveSkillCompletion,
  skillName: string,
  maxLength?: number
): { value: string; caret: number } | null {
  const suffix = completion.end === value.length ? " " : "";
  const replacement = `${completion.trigger}${skillName}${suffix}`;
  const nextValue = `${value.slice(0, completion.start)}${replacement}${value.slice(completion.end)}`;
  if (maxLength !== undefined && nextValue.length > maxLength) return null;
  return {
    value: nextValue,
    caret: completion.start + replacement.length,
  };
}
