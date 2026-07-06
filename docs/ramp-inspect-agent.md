We built our own background coding agent: Inspect. Inspect writes the code like any other coding
agent, but closes the loop on verifying its work by having all the context and tools needed to prove
it, as a Ramp engineer would.

For backend work, it can run tests, review telemetry, and query feature flags. For frontend, it
visually verifies its work and gives users screenshots and live previews. Agents should have agency,
and so we made sure Inspect is never limited by missing context or tools, but only by model
intelligence itself.

Each session runs in a sandboxed VM on Modal with everything an engineer would have locally: Vite,
Postgres, Temporal, the works. It’s wired into Sentry, Datadog, LaunchDarkly, Braintrust, GitHub,
Slack, and Buildkite. It supports all frontier models, MCPs, custom tools, and skills that encode
how we ship at Ramp. This also lets builders of all backgrounds, contribute with the tooling and
setup an engineer would.

Because Inspect sessions are fast to start and effectively free to run, you can use them without
rationing local checkouts or worktrees. A builder can kick off multiple versions of the same prompt,
and just see which one lands. They can try different approaches or swap models without thinking
twice. There’s no limit to how many sessions you can have running concurrently, and your laptop
doesn’t need to be involved at all.

This also means you can capture ideas the moment you have them. Notice a bug while winding down for
the night? Kick off a session, talk to it if you want (we added voice), and check the PR in the
morning.

The interface understands that people rely on a rich variety of workflows. You can chat with Inspect
in Slack and send it screenshots, use the Chrome extension to highlight specific changes to
elements, prompt it on the web interface, discuss on the Pull Request, and even drop into a
web-based VS Code editor to make manual changes. All changes are synced to the session, so you never
lose your work while switching around. Plus, every session is multiplayer. Send your session to any
colleague, and they can help take it home.

We want Inspect sessions to be fast, and session speed should only be limited by model-provider
time-to-first-token. Everything else, like cloning and installing, is done before you start your
session. When background agents are fast, they’re strictly better than local: same intelligence,
more power, and unlimited concurrency. You can go home and let Inspect cook (and if you’re so
inclined, resume after dinner from your couch and mobile phone).

Internal adoption charts have been vertical: ~30% of all pull requests merged to our frontend and
backend repos are written by Inspect. It only took a couple months for us to reach this level of
usage, and it continues to grow. We didn’t force anyone to use Inspect over their own tools. We
built to people’s needs, created virality loops through letting it work in public spaces, and let
the product do the talking.

We think anyone should be able to build this. Owning the tooling lets you build something
significantly more powerful than an off-the-shelf tool will ever be. After all, it only has to work
on your code. To make this easy to replicate, we’ve written a spec of what we’ve built so far. Paste
the link to this post into a coding agent and let it begin building.

Sandbox At the core of a hosted coding agent is the execution environment. Whenever you start a new
coding session, you want to spin up a new sandbox that has a full development environment. This will
allow the agent to work effectively, by having access to all the tools a human would have, while
also being isolated from other work. It’s also crucial that time-to-first-token is as fast as
possible.

The key challenge is spinning up full dev environments quickly. Modal solves this: it's a cloud
platform for AI infrastructure we use across Ramp. Their sandboxes start near instantly, and file
system snapshots allow us to freeze and restore state later. With Modal Sandboxes, we take the
following approach:

We have an image registry, defining an image for each code repository We build these images every 30
minutes, meaning that we clone the repository, install any runtime dependencies, and do any initial
setup and build commands If you use GitHub: You will need to have a GitHub app, and generate a new
app installation token on each clone, so that it can clone the repository without knowing what user
will consume it As git operations are not tied to a GitHub user, you will simply update the git
config’s user.name and user.email when committing and pushing the changes We save a snapshot of the
image in this completed state When we later start the session, we spin up a new sandbox that starts
from this stored snapshot This ensures that at most, the repository is 30 minutes out of date This
makes the synchronization with the latest code in the repository much faster, as there’s only up to
30 minutes of changes to sync When the agent is finished making changes, we take another snapshot,
and restore to it later if the sandbox has exited and the user sends a follow up

You now need to set up an agent to do work in the sandbox. We strongly recommend using OpenCode, an
open source coding agent. We believe it has critical advantages over other agents:

It is structured as a server first, with its TUI and desktop app just being clients on top You want
the ability to create as many custom clients as possible down the line, as you want to put your
coding agent wherever your team works OpenCode was the strongest technical implementation we found,
as it has a fully typed SDK, and comprehensive plugin system If something is unclear from the
documentation, you can simply ask the AI to read the code of OpenCode itself, and figure out exactly
what the behaviour should be This is something we believe is highly underrated in development with
AI You want it to be as easy as possible for the agent to understand how it works, without it
hallucinating what it believes is its own behaviour As such, having the code as its source of truth
is extremely powerful If you build something great, you will get the OpenCode team to work with you
Some optimizations you should add for increased speed:

Warm the sandbox for your session as soon as a user starts to type their prompt This lets it start
cloning the latest changes, and doing any initial setup in the newly created sandbox before the user
has even hit enter If your spin up is fast, it can be ready before the user finishes typing, making
the prompt feel as fast as it would on a local machine Allow your agent to start reading files
immediately, even if the sync from the latest base branch is not complete yet In a large enough
repository, it is unlikely that an incoming prompt is going to modify a file changed in the last 30
minutes As such, you can let it start researching immediately, and avoid any latency from git here
However, ensure that you block file edits until synchronization is complete OpenCode makes this easy
for you, as you can write a plugin that listens to the tool.execute.before event, and block any
write or edit calls until the sync is done Move as much as you can to the build step for your
repository images Thoroughly investigate what you need to do to have a complete development
environment, and do literally everything you can do beforehand Even things like running your app and
test suite once are helpful, as these may write cached files that a second run will make use of It
doesn’t matter if your image build is long, as users are just using the last built image, and
therefore will not see how long this step took You should decide if you want follow up prompts that
are sent during an execution to be inserted as soon as possible, or queued to be run after the
current prompt is complete. We chose to queue them, as we found it not only easier to manage, but
also helpful for sending over thoughts on next steps while the AI is still working. Be sure to build
a mechanism to also allow an agent to be stopped mid-way.

Amongst many tools you could build for your agent, a crucial tool is one that allows it to spawn
sessions itself. Don’t be afraid of the possibility of it spawning too many agents; frontier models
are smart enough to contain themselves. Create a tool that starts a new session, and a tool that
lets it read the status of any session, so it can check in periodically while the main session still
does work. Prompt engineer this so you can either do research tasks (especially across different
repositories), or create many smaller pull requests for one major task.

API You want to build an API that is going to be able to support input from a variety of clients,
whether that be a chat interface, a Slack bot, a Chrome extension, or any other input you can think
of in the future. You want the state to be synchronized across all clients. You also want to build
multiplayer support, which we’ll explain shortly.

The best system we found for this was Cloudflare’s Durable Objects. Every session gets its own
SQLite database. This ensures high performance, even when you have hundreds of sessions running in
parallel, as no one session can impact another. This is particularly important given that the agent
will be streaming tokens to you in real time, so you will likely receive hundreds of updates in a
very short time frame.

Cloudflare also provides its Agents SDK, which we found was particularly useful for handling the
real-time streaming between the sandbox, the API, and any attached clients. It provides helpful
abstractions over the WebSockets Hibernation API, which allows for sockets to stay open without
incurring compute costs during idle periods.

We believe that multiplayer is a mission-critical feature, and something we have not seen in any
other product yet. The idea behind multiplayer should be that any number of people can work in one
session together, just as they would in a branch of code. Each person’s prompt that causes code
changes should be attributed to them. This is useful for a variety of scenarios:

Teaching non-engineering builders, such as product managers and designers, how to effectively
utilize the AI for their own work Doing live QA sessions with your team, as each person can queue up
changes they find in real-time, instead of writing a ticket to do it later Reviewing another
person’s pull request, asking the AI to quickly make requested changes instead of just commenting
them and waiting for the original author to pick them up If you build a system that synchronizes
across clients, multiplayer support should be nearly free to add. Just ensure your data model does
not strongly tie a session to only one author at a time, and be sure to pass authorship info to each
prompt that’s sent to the coding agent.

You will need to add authentication. Consider using GitHub authentication if your code lives in
GitHub, as this will give you a user token that you can then use to open a pull request on behalf of
the user. This is strongly preferred over having it open pull requests as the app itself. In the
latter scenario, this would allow for any user to approve their own changes. You do not want to
knowingly create a vector for unreviewed code to go into the codebase.

Our setup is to have the sandbox push the changes (updating the git user as previously mentioned),
and then send an event to the API with the branch name and session ID. The API will then use the
user’s GitHub token to call GitHub’s pull request API. You should also set up a GitHub webhook to
listen for branch and pull request events, so you can keep track of when a pull request is updated,
merged, or closed.

Clients Client choices should be to taste, focusing on where your organization primarily works.
These are just our most effective clients. As you have now built a generic sandbox and API for
remote coding, you can build any client on top.

Slack Choose whatever team communication tool your company uses. We believe this is extremely
effective, as it not only lets you quickly tackle issues from a variety of sources, but also
introduces a virality loop. As people in your organization use it, others will see it, and they’ll
learn how to use it themselves.

Slack’s APIs are not hard to start with, as they have a plethora of client libraries. Your goal here
is to make it as seamless as possible to use. Do not force the user to learn syntax to use a chat
bot. They should just be able to chat with it, and it should figure it out.

A critical piece is to build a classifier to determine what repository to work in. Take the user’s
incoming message, any thread context (if sent in a thread), and the channel’s name. Give that to a
fast model (we use GPT 5.2 with no reasoning), along with descriptions of every repository your
coding agent can access. Be sure to give it hints on the most common repositories, and example
classifications. Be sure to include an “unknown” option, so the AI can ask the user if unsure. You
may need to tweak this at first, but this significantly lowers the barrier for entry.

The Slack bot should also be very clear when it’s working vs. when it’s done. Give the agent a Slack
message tool, so it can post updates about what it’s doing at important inflection points. Use Block
Kit to design an appealing layout, such as including metadata about the repository and working
status as context blocks.

Most importantly: Since this is your own Slack bot, we recommend adding your own emojis for the bot
to use. It’s a lot more fun than just using generic emojis.

Web You should have a polished web client, so users can work on sessions from anywhere. Ensure it
works well on both desktop and mobile. If you use Cloudflare’s Agents SDK, you’ll have easy
constructs for handling the real-time streaming.

What matters more here is some additional functionality you can expose uniquely in the interface:

A hosted VS Code instance, which runs inside of the sandbox, so people can make manual changes
without having to clone the repository locally A streamed desktop view, so you can work alongside
the agent for web projects, having it perform computer use to navigate and verify its changes
visually It can also take before and after screenshots, which you can append to the pull request
descriptions As well, you should build a statistics page. Include your entire organization’s usage,
particularly surfacing how many sessions result in a merged pull request. This is the most important
metric to track, as merged pull requests indicate that the agent is producing valuable work. Show
these as metrics over time, so you can inspire more growth. A live “humans prompting” count is a
good gauge as well, which we base on the number of users that have sent a prompt in the last 5
minutes.

Chrome extension To inspire usage across more non-engineering users, you should build a Chrome
extension that allows you to make changes to any React app visually. Use the Chrome extension
sidebar API to build a chat interface that also includes a screenshot tool. However, instead of
sending the actual image (which consumes many tokens), it should use the DOM and React internals to
get the full tree of elements in the selected area. We built our own, to tie directly into our React
app and its debugging internals, but if you need a starting point, you could use something like
React Grab.

To distribute this extension, you can use a managed device policy. This allows you to avoid the
Chrome Web Store entirely, and also will increase adoption by putting it in your team’s browsers.
You’ll need to stand up an extension update server; these return a pretty simple manifest and the
CRX. Follow the attached link to build a compliant server. Then, you’ll set the
ExtensionInstallForcelist MDM property, pointing it to your extension update server.
