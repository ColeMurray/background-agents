"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  MEMBER_MERGE_BLOCKER_MESSAGES,
  type MemberMergeInput,
  type MemberMergePreview,
  type MemberMergeResult,
  type WorkspaceMember,
} from "@open-inspect/shared/rbac";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { describeIdentity, summarizeMergeCounts } from "./member-merge-summary";

/** Workspace operations the merge dialog performs on the administrator's behalf. */
export interface MergeMembersActions {
  previewMerge: (input: MemberMergeInput) => Promise<MemberMergePreview>;
  mergeMembers: (input: MemberMergeInput) => Promise<MemberMergeResult>;
}

interface MergeMembersDialogProps extends MergeMembersActions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: WorkspaceMember[];
  currentUserId: string | null;
}

function memberName(member: WorkspaceMember): string {
  return member.displayName ?? member.email ?? member.userId;
}

/** Names a member unambiguously; duplicate accounts often share a display name. */
function memberLabel(member: WorkspaceMember): string {
  return member.displayName && member.email
    ? `${member.displayName} (${member.email})`
    : memberName(member);
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

/**
 * Lets an administrator fold a duplicate account (for example, a Slack-created user) into the
 * account a person signs in with: choose both, review a dry run, then confirm.
 */
export function MergeMembersDialog({
  open,
  onOpenChange,
  members,
  currentUserId,
  previewMerge,
  mergeMembers,
}: MergeMembersDialogProps) {
  const [targetUserId, setTargetUserId] = useState<string>("");
  const [sourceUserId, setSourceUserId] = useState<string>("");
  const [preview, setPreview] = useState<MemberMergePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setTargetUserId("");
    setSourceUserId("");
    setPreview(null);
    setConfirmed(false);
    setError(null);
  }

  function changeOpen(next: boolean) {
    if (busy) return;
    if (!next) reset();
    onOpenChange(next);
  }

  function choose(role: "target" | "source", userId: string) {
    if (role === "target") setTargetUserId(userId);
    else setSourceUserId(userId);
    setPreview(null);
    setConfirmed(false);
    setError(null);
  }

  function swap() {
    setTargetUserId(sourceUserId);
    setSourceUserId(targetUserId);
    setPreview(null);
    setConfirmed(false);
    setError(null);
  }

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause, fallback));
    } finally {
      setBusy(false);
    }
  }

  const loadPreview = () =>
    run(async () => {
      setConfirmed(false);
      setPreview(await previewMerge({ sourceUserId, targetUserId }));
    }, "Couldn't preview this merge");

  const confirmMerge = () =>
    run(async () => {
      if (!preview) return;
      await mergeMembers({ sourceUserId, targetUserId });
      toast.success(
        `Merged ${memberLabel(preview.source.member)} into ${memberLabel(preview.target.member)}`
      );
      reset();
      onOpenChange(false);
    }, "Couldn't merge these accounts");

  const summary = preview?.counts ? summarizeMergeCounts(preview.counts) : null;
  const canChoose = !busy && !preview;

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogTitle>Merge accounts</DialogTitle>
        <DialogDescription>
          Combine two accounts that belong to the same person, such as a Slack account and a GitHub
          account that use different emails.
        </DialogDescription>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
          <MemberPicker
            id="merge-target"
            label="Account to keep"
            hint="Keeps its sign-in, role, and email."
            value={targetUserId}
            exclude={sourceUserId}
            members={members}
            disabled={!canChoose}
            onChange={(userId) => choose("target", userId)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="mb-6 justify-self-center"
            onClick={swap}
            // Swapping would make the signed-in account the merge-in source.
            disabled={
              !canChoose || (!sourceUserId && !targetUserId) || targetUserId === currentUserId
            }
            aria-label="Swap accounts"
            title="Swap accounts"
          >
            <span aria-hidden="true">⇄</span>
          </Button>
          <MemberPicker
            id="merge-source"
            label="Account to merge in"
            hint="Its data moves over, then it is removed."
            value={sourceUserId}
            exclude={targetUserId}
            members={members}
            currentUserId={currentUserId}
            disabled={!canChoose}
            onChange={(userId) => choose("source", userId)}
          />
        </div>

        {error && <ErrorBanner>{error}</ErrorBanner>}

        {preview && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <AccountCard title="Keep" account={preview.target} />
              <AccountCard title="Merge in and remove" account={preview.source} />
            </div>

            {preview.blocker ? (
              <ErrorBanner>{MEMBER_MERGE_BLOCKER_MESSAGES[preview.blocker]}</ErrorBanner>
            ) : (
              summary && (
                <section className="space-y-2 rounded-md border border-border p-4">
                  {summary.teamLeadPromotions > 0 && (
                    <p className="rounded-md border border-warning/30 bg-warning-muted p-3 text-sm text-foreground">
                      <span className="font-medium">Access change:</span>{" "}
                      {memberName(preview.target.member)} becomes a lead of{" "}
                      {summary.teamLeadPromotions === 1
                        ? "1 team"
                        : `${summary.teamLeadPromotions} teams`}{" "}
                      that {memberName(preview.source.member)} leads.
                    </p>
                  )}
                  <h4 className="text-sm font-medium text-foreground">
                    What moves to {memberName(preview.target.member)}
                  </h4>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
                    {summary.moves.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                    {summary.otherRecords > 0 && (
                      <li>
                        {summary.otherRecords} other{" "}
                        {summary.otherRecords === 1 ? "record" : "records"} (authorship and
                        settings)
                      </li>
                    )}
                    {summary.moves.length === 0 && summary.otherRecords === 0 && (
                      <li>No other records — only the account itself is removed.</li>
                    )}
                  </ul>
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    {summary.combinedSkillProfiles > 0 && (
                      <li>
                        {summary.combinedSkillProfiles === 1
                          ? "1 skill profile is"
                          : `${summary.combinedSkillProfiles} skill profiles are`}{" "}
                        combined with the kept account&apos;s profile of the same name.
                      </li>
                    )}
                    {summary.replacedSettings.length > 0 && (
                      <li>
                        The kept account&apos;s {summary.replacedSettings.join(" and ")} stay; the
                        merged-in account&apos;s are discarded.
                      </li>
                    )}
                    {summary.duplicates > 0 && (
                      <li>
                        {summary.duplicates} duplicate{" "}
                        {summary.duplicates === 1 ? "record is" : "records are"} dropped because the
                        kept account already has the same team, session, or sign-in.
                      </li>
                    )}
                    {summary.endedSignIns > 0 && (
                      <li>
                        {memberName(preview.source.member)} is signed out of{" "}
                        {summary.endedSignIns === 1
                          ? "1 browser session"
                          : `${summary.endedSignIns} browser sessions`}
                        .
                      </li>
                    )}
                    {summary.emailCarriedOver && (
                      <li>
                        The kept account has no email, so it takes{" "}
                        {preview.source.member.email ?? "the removed account's email"}.
                      </li>
                    )}
                  </ul>
                </section>
              )
            )}

            {!preview.blocker && (
              <div className="flex items-start gap-2">
                <Checkbox
                  id="merge-confirm"
                  checked={confirmed}
                  disabled={busy}
                  onCheckedChange={(checked) => setConfirmed(checked === true)}
                />
                <Label htmlFor="merge-confirm" className="leading-snug">
                  I understand {memberLabel(preview.source.member)} will be permanently removed.
                  This can&apos;t be undone.
                </Label>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {preview ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setPreview(null);
                  setConfirmed(false);
                  setError(null);
                }}
              >
                Back
              </Button>
              <Button
                type="button"
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={busy || !!preview.blocker || !confirmed}
                onClick={() => void confirmMerge()}
              >
                {busy ? "Merging..." : "Merge accounts"}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => changeOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={busy || !sourceUserId || !targetUserId}
                onClick={() => void loadPreview()}
              >
                {busy ? "Checking..." : "Review merge"}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MemberPicker({
  id,
  label,
  hint,
  value,
  exclude,
  members,
  currentUserId,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  exclude: string;
  members: WorkspaceMember[];
  /** When set, the signed-in user is listed but cannot be chosen. */
  currentUserId?: string | null;
  disabled: boolean;
  onChange: (userId: string) => void;
}) {
  const selected = members.find((member) => member.userId === value);
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} aria-label={label} className="text-left">
          <SelectValue placeholder="Choose a member">
            {selected ? memberLabel(selected) : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {members
            .filter((member) => member.userId !== exclude)
            .map((member) => {
              const isSelf = currentUserId === member.userId;
              return (
                <SelectItem key={member.userId} value={member.userId} disabled={isSelf}>
                  {memberLabel(member)}
                  {isSelf ? " — you" : ""}
                </SelectItem>
              );
            })}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function AccountCard({ title, account }: { title: string; account: MemberMergePreview["source"] }) {
  const { member, identities } = account;
  return (
    <article className="min-w-0 space-y-2 rounded-md border border-border p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="min-w-0">
        <p className="truncate font-medium text-foreground">{memberName(member)}</p>
        <p className="truncate text-xs text-muted-foreground">{member.email ?? "No email"}</p>
      </div>
      <p className="text-sm text-foreground">
        {member.role.name}
        {member.suspendedAt !== null && <span className="text-muted-foreground"> · Suspended</span>}
      </p>
      <div className="flex flex-wrap gap-1">
        {identities === null ? (
          <span className="text-xs text-muted-foreground">Linked sign-ins hidden</span>
        ) : identities.length === 0 ? (
          <span className="text-xs text-muted-foreground">No linked sign-ins</span>
        ) : (
          identities.map((identity, index) => (
            <Badge key={`${identity.provider}:${index}`}>{describeIdentity(identity)}</Badge>
          ))
        )}
      </div>
    </article>
  );
}
