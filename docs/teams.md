# Teams

A Team is a reusable, host-local definition. A Team Run is one execution of that definition against an Objective in an existing Workspace.

[Assignments and Artifacts](assignments.md) define the durable intent and explicit handoff contract layered onto this lifecycle. Assignment-backed admission freezes that intent and its Artifact plan. Assignment-backed execution persists and resolves those exact Artifacts; objective-only records retain their inline compatibility handoff.

## Ownership

The daemon that stores a Team owns it. Team and Team Run IDs are daemon-local. The app qualifies them with `serverId`; stored and wire records do not.

Definitions and runs are separate records. Deleting a Team never deletes its run history. A run freezes the accepted Team revision and Workspace facts, so later edits, deletion, or Workspace removal cannot rewrite history.

Disk schemas belong to the server. Protocol schemas project those records onto wire DTOs. Do not export a persistence schema as the protocol contract.

## Definition

A Team has:

- a name and shared instructions;
- stable roles with names, instructions, and a host-local Paseo Agent Profile ID;
- an ordered workflow of stable steps that reference roles.

The first workflow is sequential. A role may appear in more than one step. A step may add instructions for that occurrence. There are no conditions, retries, or fan-out.

Paseo Agent Profiles own how one worker launches: provider, model, mode, thinking, feature settings, and provider-native options. Team roles own what that worker does. Do not copy profile launch fields into a Team definition.

Profile IDs are host-local. A Team remains visible when one is missing or deleted, but it cannot run until every role references exactly one configured profile. Never select another profile, provider, or model as a fallback.

A Team does not own a Workspace. Starting a run supplies an opaque `workspaceId`; the daemon resolves its persisted `cwd` and snapshots the Workspace identity. Never infer or recover a Workspace from a client-supplied path.

## Run acceptance

Team updates, deletion, and run start use the expected Team revision. Run start also uses a caller-retained idempotency key. The repository must snapshot the accepted revision and write the run before execution begins.

Run admission reads the daemon's authoritative Agent Profile configuration once. It materializes each referenced profile with vanilla Paseo semantics, validates the provider, model, mode, thinking, feature settings, and provider-native options against the selected Workspace, and freezes the profile ID and resolved launch values into every run step. Later profile edits affect only future admissions. Missing or invalid profiles make future starts fail explicitly; they cannot change an active or historical run.

A capable client previews a start through the same daemon preflight used by admission. The preview
returns the accepted Workspace facts, sanitized resolved launches, frozen security postures, and a
fingerprint over the complete accepted Workspace and launch configuration. Start sends that
fingerprint; the daemon repeats preflight and rejects the request if profile, provider, or Workspace
facts changed. Provider-native options participate in the fingerprint but never enter the preview
DTO. Older clients may omit the fingerprint for protocol compatibility. Clients connected to an
older daemon keep the established start path but must label the unavailable preview.

Raw provider-native options remain in daemon-owned run persistence and launch requests. Team Run DTOs do not expose them. New runs also freeze a provider-authored security posture beside each resolved launch. The posture contains bounded, redacted facts for filesystem writes, network access, and tool or shell policy. It reports `enforced` only when the frozen launch proves a fail-closed provider restriction; inherited settings, unsupported controls, and custom providers remain `unavailable` or `policy_only`.

The posture records facts derived from the frozen launch configuration. It does not add enforcement, and it never derives claims about credentials, secrets, repository isolation, production access, or host containment. Instructions and Artifact content are policy context, not technical controls. Runs created before posture snapshots remain without one; never reconstruct history from a current Agent Profile.

Only one Team Run may own a Workspace at a time. The lock covers active, permission-waiting, stopping, and stop-failed runs. It does not isolate the Workspace from people or ordinary Paseo agents.

## Execution

The daemon service coordinates root Paseo agents. Each reached workflow step creates one agent in the selected Workspace from the frozen launch values; execution never resolves the Agent Profile again. Correlation labels identify the Team, run, role, and step. Do not set `paseo.parent-agent-id`; that label means an agent-created child and carries cascade and archive behavior.

Compose each initial prompt from these bounded sections:

1. Team name and instructions.
2. Role name and instructions.
3. Step instructions, when present.
4. Objective.
5. Exact frozen input Artifacts for Assignment-backed runs, or the immediately previous final response for objective-only runs.

For an Assignment-backed step, persist its bounded final response under the preallocated output ID before committing step success or creating the next agent. Reject blank output. Resolve downstream inputs by their frozen IDs and verify the Assignment revision, Team Run, producing step, role, agent, success state, and descriptor before agent creation. Artifact content is capped at 32 KiB each and 32 KiB total per prompt. Delimit it as untrusted context with identity, provenance, and truncation facts.

For an objective-only step, delimit the previous response as untrusted handoff context. Cap it at 4 KiB of UTF-8 and state when it was truncated. An empty final response gets an explicit empty marker. Do not pass the full transcript.

The handoff is not a security or context-isolation boundary. Roles share the Workspace filesystem and may use daemon tools. Run records keep step status, timestamps, agent IDs, frozen configuration, and bounded errors; agent timelines remain authoritative for output.

## Lifecycle

One foreground stream owns a step from prompt admission through completion, failure, or cancellation. A permission request is an intermediate checkpoint. Persist `waiting_for_permission`, hold the Workspace lock, surface the ordinary agent permission UI, and resume the same turn after the response. A denied permission is not itself a failed step; classify the eventual terminal event.

Cancellation uses the ordinary agent cancellation path and drains the stream to a terminal event. A refused cancellation is `stop_failed`, remains nonterminal, and retains the Workspace lock.

Workspace archive or removal wins over the Team Run. Stop the current step and create no later agents. Keep the preexisting Workspace and every created agent.

Shutdown fences new starts before agents close. Mark in-flight runs interrupted and cancel or settle them best-effort. On startup, mark every leftover active run interrupted. Never replay a prompt whose effects are uncertain.

## Roadmap boundary

Stored v0.2 runs remain objective-only: their Objective is not a durable Assignment and their bounded inline handoff is not an Artifact. [Assignments and Artifacts](assignments.md) own the v0.3 path; stored runs and older clients keep the legacy behavior.

Teams still add no generic policy engine, sandbox, supervisor, conditional revision loop, retry, fan-out, new scheduler, or Team-owned Workspace creation. The frozen security posture reports provider behavior already selected by the Agent Profile; it does not create a new boundary.
