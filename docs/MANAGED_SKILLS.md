# Managed Skills

Managed skills give agents reusable instructions and supporting files. Use them to standardize
workflows such as deployments, code reviews, incident response, or project-specific conventions
without repeating the same guidance in every prompt.

A skill can apply to every session or only to selected repositories and environments. Before
starting a session, you can use all matching skills, none of them, or a personal profile containing
the ones you prefer.

> Managed skills are trusted content, not a permission boundary. A skill can direct the agent to use
> tools, credentials, and network access already available in the session. Review instructions and
> scripts before enabling them.

---

## Quick Start

1. Go to **Settings > Skills**.
2. On **Shared skills**, click **New skill**.
3. Enter a canonical name, description, and instructions.
4. Choose the repositories or environments where the skill should apply. New skills apply to **All
   sessions (global)** by default.
5. Click **Validate**, review the generated `SKILL.md`, then click **Create skill**.
6. Start a new session. Leave the skill selector on **All applicable** to include every skill that
   matches the selected target.

Open the session's right sidebar and expand **Managed skills** to see exactly which skills and
revisions were included.

---

## Skills, Assignments, and Profiles

| Concept              | Purpose                                                        | Who can use it                           |
| -------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| **Shared skill**     | Stores reusable instructions and optional supporting files     | Everyone using the Open-Inspect instance |
| **Assignment**       | Controls which session targets a shared skill applies to       | Everyone using the shared skill          |
| **Personal profile** | Saves a preferred subset of shared skills for session creation | Only the profile's owner                 |

Profiles do not change a skill's assignments. If a profile contains a disabled skill or one that
does not apply to the selected target, Open-Inspect ignores that entry.

Shared skills are installation-wide. Any signed-in user can create, edit, enable, disable, assign,
or delete them. Coordinate changes with other users of your Open-Inspect instance.

---

## Creating a Shared Skill

Open **Settings > Skills > Shared skills**, then select **New skill**.

### Skill content

| Field              | What to enter                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Canonical name** | Required. A unique name using lowercase letters, numbers, and single hyphens, such as `deploy-service`. The name cannot be changed later. |
| **Description**    | Required. A short explanation of when and why the agent should use the skill.                                                             |
| **Instructions**   | The workflow, rules, examples, and expected outcomes in Markdown. This may be empty, but instructions are recommended for most skills.    |

Write instructions that make the skill's trigger and outcome clear. For example:

```markdown
## When to use

Use this skill when deploying the API service to staging.

## Workflow

1. Run the pre-deployment checks in `scripts/preflight.sh`.
2. Summarize any failed checks and stop before deployment.
3. Deploy using the repository's documented staging command.
4. Report the deployed revision and health-check result.
```

### Optional fields

- **License** records licensing information for the skill.
- **Compatibility** describes environment or tool requirements.
- **Metadata** accepts a JSON object whose keys and values are strings, for example
  `{"team":"platform"}`.

Open-Inspect generates the skill's `SKILL.md` from these fields. You do not need to create it as a
supporting file.

### Supporting files

Select **Add file** to include text-based references, templates, assets, source files, or scripts.
Use relative paths such as:

```text
references/runbook.md
assets/review-template.md
scripts/preflight.sh
```

Supporting files must be UTF-8 text; binary uploads and archive imports are not supported. Mark a
file **Executable** only when its path is under `scripts/`.

You can author files directly in the editor. Managed skills currently cannot be imported from a Git
repository, marketplace, directory, or archive.

### Validate before saving

Click **Validate** to preview and check the skill without saving it. The result shows:

- The generated `SKILL.md`
- Total content size
- A SHA-256 digest identifying the content

Validation is optional. **Create skill** and **Save new revision** perform the same checks when you
save.

---

## Assigning a Skill

Assignments determine when a skill is available. A skill applies when any one of its assignments
matches the session target.

| Assignment                | Applies to                                             |
| ------------------------- | ------------------------------------------------------ |
| **All sessions (global)** | Every session, including sessions without a repository |
| **Repository**            | Sessions containing the selected repository            |
| **Environment**           | Sessions launched from the selected environment        |

You can select several repositories and environments. An environment session can match a global
assignment, the environment assignment, and assignments for repositories contained in that
environment.

If you remove all assignments, the skill remains in the catalog but is not applicable to any new
session until it is assigned again. Assignments do not override the skill's enabled or disabled
state.

---

## Editing and Managing Skills

Select a skill under **Settings > Skills > Shared skills** to edit its content, supporting files, or
assignments.

- Select **Save new revision** to save your changes. Content changes create a revision; changing
  assignments alone updates the scope without creating a content revision. The canonical name cannot
  be edited.
- Use the switch beside a skill to enable or disable it. Disabled skills are excluded from new
  sessions.
- Select **Delete** to remove a skill from the catalog. There is no restore action in the web app.
- If another user updates the skill while you are editing it, your save is rejected so that you do
  not overwrite their changes. Reload the latest revision and apply your changes again.

Edits, assignment changes, disabling, and deletion affect future sessions only. Existing sessions
keep the exact skill revisions selected when they were created.

---

## Creating a Personal Profile

Profiles make it easy to select the same subset of shared skills repeatedly. They are private to
your account and do not affect other users.

1. Go to **Settings > Skills > My profiles**.
2. Click **New profile**.
3. Enter a unique profile name.
4. Select up to 20 shared skills.
5. Click **Save profile**.

A profile is a filter, not an override. At session creation, Open-Inspect includes only profile
skills that are both enabled and assigned to the selected target. Disabled skills remain visible in
the profile editor with a `(disabled)` suffix.

Select an existing profile to rename it or change its included skills. Select **Delete** to remove a
profile; deleting a profile does not delete its shared skills.

---

## Choosing Skills for a Session

After selecting no repository, a repository, a repository set, or an environment on the new-session
page, open the skill selector beside the model and reasoning controls.

| Selection            | Result                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------- |
| **All applicable**   | Includes every enabled skill whose assignment matches the target. This is the default. |
| **None**             | Starts the session without managed skills.                                             |
| **Personal profile** | Includes the enabled, applicable skills saved in that profile.                         |

The number beside the selector previews how many skills will be included. If a profile shows **N
ignored**, those entries are disabled or are not assigned to the selected target.

Automations and integrations that do not offer a skill selector use **All applicable**. Child
sessions created by an agent inherit the parent's exact set of skills.

There is no separate installation step. Before the agent starts, Open-Inspect validates and installs
the selected skills automatically. If selected content cannot be fetched, validated, or installed,
the session fails to start rather than silently omitting a skill.

---

## Inspecting Skills in a Session

Expand **Managed skills** in the session's right sidebar. The section shows:

- The selection used: **All applicable**, **None**, or a profile name
- Each skill's canonical name and description
- The pinned revision and abbreviated content digest
- Why the skill matched, such as **Global**, **Repository**, or **Environment**

Skills are pinned when the session is created. Restarting or restoring that session continues to use
the same revisions; it does not pick up newer edits. Start a new session to use the latest catalog.

---

## Limits and File Rules

| Constraint                         |                 Limit |
| ---------------------------------- | --------------------: |
| Canonical name                     |         64 characters |
| Description                        |      1,024 characters |
| License                            |        200 characters |
| Compatibility                      |        500 characters |
| Metadata key                       |        100 characters |
| Metadata value                     |        500 characters |
| Supporting files                   | 99 per skill revision |
| Individual file                    |               256 KiB |
| Complete skill revision            |                 1 MiB |
| Skills in a profile or session     |                    20 |
| Managed skill content in a session |                 5 MiB |

Supporting-file paths must:

- Be relative paths using `/`, not absolute paths or backslashes
- Avoid empty segments, `.` segments, and `..` segments
- Be no more than 10 path segments or 240 UTF-8 bytes
- Not contain control characters
- Be unique and not conflict with another file or directory path
- Not use `SKILL.md`, which Open-Inspect generates

Canonical names must be unique. The names `agent-browser`, `record-video`, `upload-screenshot`,
`visual-verification`, and `customize-opencode` are reserved by the sandbox runtime.

---

## Troubleshooting

### A profile says that skills were ignored

Open the profile under **Settings > Skills > My profiles** and check whether the entries are
disabled. Then open each shared skill and confirm that its assignments match the session's
repository or environment.

### Changes are missing from an existing session

Managed skills are pinned at session creation. Start a new session to receive a newer revision,
changed assignments, or newly enabled skills.

### A session fails to start because of a skill name collision

A managed skill cannot have the same name as another skill available in the sandbox, including one
provided by a repository. Rename or remove the other skill, or create a new managed skill with a
different canonical name and update its assignments and profiles.
