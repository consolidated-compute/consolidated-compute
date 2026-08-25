# Teams

A Team is a reusable, host-local definition. A Team Run is one execution of that definition against an Objective in an existing Workspace.

## Ownership

The daemon that stores a Team owns it. Team and Team Run IDs are daemon-local. The app qualifies them with `serverId`; stored and wire records do not.

Definitions and runs are separate records. Deleting a Team never deletes its run history. A run freezes the accepted Team revision and Workspace facts, so later edits, deletion, or Workspace removal cannot rewrite history.

Disk schemas belong to the server. Protocol schemas project those records onto wire DTOs. Do not export a persistence schema as the protocol contract.

## Definition

A Team has:

- a name and shared instructions;
- stable roles with names, instructions, and provider/model preferences;
- an ordered workflow of stable steps that reference roles.

The first workflow is sequential. A role may appear in more than one step. A step may add instructions for that occurrence. There are no conditions, retries, or fan-out.

The saved provider/model values are preferences, not an availability claim. Team authoring uses the host catalog. Run acceptance validates every step against the selected Workspace catalog and freezes the accepted launch values. A null accepted model means that the provider exposes or owns no concrete model selection; it does not make a model ID required for providers that run without one.

A Team does not own a Workspace. Starting a run supplies an opaque `workspaceId`; the daemon resolves its persisted `cwd` and snapshots the Workspace identity. Never infer or recover a Workspace from a client-supplied path.

## Run acceptance

Team updates, deletion, and run start use the expected Team revision. Run start also uses a caller-retained idempotency key. The repository must snapshot the accepted revision and write the run before execution begins.

Only one Team Run may own a Workspace at a time. The lock covers active, permission-waiting, stopping, and stop-failed runs. It does not isolate the Workspace from people or ordinary Paseo agents.

## Execution

The daemon service coordinates root Paseo agents. Each reached workflow step creates one agent in the selected Workspace. Correlation labels identify the Team, run, role, and step. Do not set `paseo.parent-agent-id`; that label means an agent-created child and carries cascade and archive behavior.

Compose each initial prompt from these bounded sections:

1. Team name and instructions.
2. Role name and instructions.
3. Step instructions, when present.
4. Objective.
5. The immediately previous step final response, when present.

Delimit the previous response as untrusted handoff context. Cap it at 4 KiB of UTF-8 and state when it was truncated. An empty final response gets an explicit empty marker. Do not pass the full transcript.

The handoff is not a security or context-isolation boundary. Roles share the Workspace filesystem and may use daemon tools. Run records keep step status, timestamps, agent IDs, frozen configuration, and bounded errors; agent timelines remain authoritative for output.

## Lifecycle

One foreground stream owns a step from prompt admission through completion, failure, or cancellation. A permission request is an intermediate checkpoint. Persist `waiting_for_permission`, hold the Workspace lock, surface the ordinary agent permission UI, and resume the same turn after the response. A denied permission is not itself a failed step; classify the eventual terminal event.

Cancellation uses the ordinary agent cancellation path and drains the stream to a terminal event. A refused cancellation is `stop_failed`, remains nonterminal, and retains the Workspace lock.

Workspace archive or removal wins over the Team Run. Stop the current step and create no later agents. Keep the preexisting Workspace and every created agent.

Shutdown fences new starts before agents close. Mark in-flight runs interrupted and cancel or settle them best-effort. On startup, mark every leftover active run interrupted. Never replay a prompt whose effects are uncertain.

## Roadmap boundary

The Objective is not a durable Assignment. The bounded inline handoff is not an Artifact. V0.2 adds no policy enforcement, sandbox, supervisor, conditional revision loop, retry, fan-out, Work Item, new scheduler, or Team-owned Workspace creation. Issues #5–#8 own those later contracts.
