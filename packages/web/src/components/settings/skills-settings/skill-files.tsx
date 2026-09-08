import type { SkillFileInput } from "@open-inspect/shared/types/skills";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PlusIcon, XIcon } from "@/components/ui/icons";

export function SkillFiles({
  files,
  onChange,
}: {
  files: SkillFileInput[];
  onChange: (files: SkillFileInput[]) => void;
}) {
  return (
    <div className="rounded border border-border-muted p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-foreground">Supporting files</h4>
          <p className="text-xs text-muted-foreground">
            Add references, assets, or scripts used by the skill.
          </p>
        </div>
        <Button
          type="button"
          size="xs"
          variant="subtle"
          onClick={() => onChange([...files, { path: "", content: "", executable: false }])}
        >
          <PlusIcon className="h-3.5 w-3.5" /> Add file
        </Button>
      </div>
      <div className="space-y-3">
        {files.length === 0 && (
          <p className="text-sm text-muted-foreground">No supporting files.</p>
        )}
        {files.map((file, index) => (
          <div key={index} className="rounded bg-muted/40 p-3">
            <div className="flex gap-2">
              <Input
                aria-label={`File ${index + 1} path`}
                value={file.path}
                onChange={(event) => {
                  const path = event.target.value;
                  onChange(
                    files.map((item, itemIndex) =>
                      itemIndex === index
                        ? {
                            ...item,
                            path,
                            executable: path.startsWith("scripts/") && item.executable,
                          }
                        : item
                    )
                  );
                }}
                placeholder="references/example.md"
                className="h-8 flex-1 font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => onChange(files.filter((_, itemIndex) => itemIndex !== index))}
                aria-label={`Remove file ${index + 1}`}
                className="text-muted-foreground hover:text-destructive"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <Textarea
              aria-label={`File ${index + 1} content`}
              value={file.content}
              onChange={(event) =>
                onChange(
                  files.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, content: event.target.value } : item
                  )
                )
              }
              rows={5}
              className="mt-2 font-mono text-xs"
            />
            <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={file.executable}
                disabled={!file.path.startsWith("scripts/")}
                onCheckedChange={(value) =>
                  onChange(
                    files.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, executable: value === true } : item
                    )
                  )
                }
              />
              Executable (scripts/ only)
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}
