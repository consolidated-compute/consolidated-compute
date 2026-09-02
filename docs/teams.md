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

Raw provider-native options remain in daemon-owned run persistence and launch requests. Team Run DTOs do not expose them. New runs also freeze a provider-authored security posture beside each resolved launch. The posture contains bounded, redacted facts for filesystem writes, network access, tool or shell policy, and native delegation. It reports `enforced` only when the frozen launch proves a fail-closed provider restriction; inherited settings, unsupported controls, and custom providers remain `unavailable` or `policy_only`.

The posture records facts derived from the frozen launch configuration. It does not add enforcement, and it never derives claims about credentials, secrets, repository isolation, production access, or host containment. Instructions and Artifact content are policy context, not technical controls. Runs created before posture snapshots remain without one; never reconstruct history from a current Agent Profile.

Supervised admission requires every selected launch to prove provider-native delegation is disabled.
Codex requires `features.multi_agent_v2: false` outside auto-review mode. Claude requires `Task`,
`Agent`, and `Workflow` in `disallowedTools`. OpenCode requires a fail-closed `task` permission.
Providers without an exact mapping cannot join a supervised run. The frozen launch keeps that control
unchanged for the run.

Only one Team Run may own a Workspace at a time. The lock covers active, permission-waiting, stopping, and stop-failed runs. It does not isolate the Workspace from people or ordinary Paseo agents.

Schedule and Hub adapters must admit unattended work with a daemon-owned policy. Admission freezes
the source type and scope, execution window, absolute deadline, maximum runtime, host and source
active-run limits, and exact provider/model allowlist. Schedule sources use their cadence as the
window; Hub events supply explicit open and close timestamps. The repository checks every resolved
launch and both active-run limits inside the serialized run write. Team, Agent Profile, schedule,
and authorization edits affect later admissions only.

Supervised execution uses the same Team Run record rather than a second coordinator store. Its
admission snapshot is Assignment-only and freezes an unused Team role as supervisor, the existing
workflow as worker templates, every resolved launch, the planned supervisor agent ID, and bounded
work, attempt, action, fan-out, and delegation limits. Dynamic worker attempts belong in the run
step ledger and preserve their template's role, launch, and step instructions. Normalized decisions
and exact Artifact references belong in the optional supervision ledger. Work Item inputs contain
unique accepted Artifact IDs. Human requests may cite only created agents and output Artifacts from
succeeded steps; planned agent IDs and preallocated output IDs are not evidence. Every durable decision
belongs to exactly one succeeded supervisor turn. Supervisor turns own decisions, never output
Artifact descriptors. Repository commands append decisions with revision and action idempotency
checks before an executor performs external work. Before each prompt, the repository appends an
active supervisor turn with its reserved decision ID. A decision may settle only that exact turn;
other active work, permission waits, cancellation, unresolved human requests, and terminal runs
reject it. Dispatch and revision decisions name one exact work item and attempt. A decision
may append steps but every preserved run and step state must follow the lifecycle transition graph;
terminal attempt history cannot be reopened or rewritten. A dispatch atomically appends one new
`creating` attempt, marks its Work Item active, enters the working phase, and reserves an output
Artifact ID across stored Team Runs. Active Work Items contain at least one launched attempt, and
an attempt has one dispatch or revision decision. The executor treats plan order as initial execution
order. A first dispatch requires every preceding Work Item to have succeeded and names their accepted
output Artifact IDs exactly. A revision requires a succeeded Work Item, includes its accepted output,
and may name other accepted run-local outputs explicitly. It appends a fresh attempt, agent,
and output Artifact ID; it never reopens an old step. Each attempt snapshot and normalized decision
freeze the exact input list. The Work Item projects its latest attempt's inputs and explicitly selects
the accepted successful attempt. A complete decision atomically
moves supervision and the outer run to successful terminal states. An escalation atomically enters
the human-wait phase with an unresolved
request after every active step has settled. Once that request is resolved or retired, later decisions
preserve it exactly; the current
single-request ledger cannot overwrite it with another escalation. Decisions preserve the outer run
state payload when its status does not change and retain its start time across transitions.
Successful terminalization requires `complete` to be the latest decision, and a pending human wait
requires `escalate` to be the latest decision. The repository stamps the supervision ledger and the
outer run with the same decision commit time; updater-supplied timestamps are not authoritative.
Resolving the frozen `continue` action persists the response before the service relaunches
supervision. The next supervisor prompt includes the request, selected action, and human note. The
response command checks the request ID and revision, then uses a caller idempotency key so stale or
duplicate clients cannot apply a second action.

Supervision also owns a bounded append-only event ledger. Decision commits, worker outcomes, human
responses, and unresolved-request retirement append an event in the same run write as the state they
describe. Events carry exact bounded role, agent, step, Work Item, attempt, decision, request, and
Artifact references. Read them newest-first through a run-bound paginated cursor. A legacy
supervised record without the event field remains readable; do not infer events for work that
predates the ledger.

The Team Run wire projection keeps its compact optional supervision summary. Separate get-state,
list-events, and respond RPCs expose the full human request and its frozen actions without exposing
the response idempotency key. A reconnect reads the persisted state; it does not reconstruct a wait
from an agent transcript. Existing Team Run and step lifecycle values do not change. Gate the client
surface once on the supervised-execution capability.

Assignment admission defaults to sequential execution. Show the supervised choice only when the
host advertises that capability, then require an unused saved Team role as supervisor and an
authoritative security preview before Start. The Team Run detail owns durable human requests and
the normalized supervision event history. Provider permission checkpoints link to the exact agent's
existing timeline instead of duplicating the permission control. Legacy runs keep the established
detail surface.

Supervised agent authority comes from persisted run membership by exact preallocated agent ID.
Correlation labels never grant access. Persist the identity before provider launch so its first tool
catalog is already restricted. Deliver that catalog through the provider's native host interface
when available. Claude uses an in-process SDK MCP server so no reusable agent credential enters the
provider process or its arguments. Other injected MCP credentials are bound to the agent identity,
and passwordless daemons reject identity-less MCP sessions instead of exposing the top-level catalog.
Supervised admission also requires a persisted daemon password because a passwordless WebSocket
treats loopback reachability as full operator authority. `PASEO_PASSWORD` does not qualify: a
same-user provider process may read the daemon ancestor's startup environment even when the variable
is removed from its child environment.
Every handler resolves the current run membership again before acting. Workers receive no Paseo
control-plane tools. A supervisor can inspect only agents, activity, and permission requests in its
run, and can answer only those requests. Ordinary agents keep the existing tool catalog.

## Execution

The daemon service coordinates root Paseo agents. Each reached workflow step creates one agent in the selected Workspace from the frozen launch values; execution never resolves the Agent Profile again. Correlation labels identify the Team, run, role, and step. Do not set `paseo.parent-agent-id`; that label means an agent-created child and carries cascade and archive behavior.

A supervised run creates its frozen supervisor once and reuses that persisted agent for bounded
structured turns. An invalid response receives at most two correction prompts on the same turn. The daemon,
not the supervisor, creates one requested worker from the named frozen template after the dispatch
decision and planned agent identity are durable. A worker terminal event is authoritative; finish
notifications may only wake the executor. Artifact or settlement errors after a provider terminal
event propagate as execution failures; never reinterpret them as a different worker outcome. The
executor may request a bounded revision only from a succeeded Work Item. It does not redispatch failed
or interrupted work. An escalation offers continuation only when the frozen ledger has a valid next
plan, dispatch, revision, or completion action. A failed Work Item offers cancellation only.

Cap the complete structured supervisor request at 64 KiB. Supervisor context uses at most 48 KiB
so the fixed action schema and correction instructions retain headroom. Truncate prose by UTF-8
bytes with explicit original-size markers, distribute the worker-instruction budget across every
frozen template, and retain every template and Work Item identity. Apply the same cap to correction
prompts and replace excess validation diagnostics with an omitted-count marker.

Compose each initial prompt from these bounded sections:

1. Team name and instructions.
2. Role name and instructions.
3. Step instructions, when present.
4. Objective.
5. Exact frozen input Artifacts for Assignment-backed runs, or the immediately previous final response for objective-only runs.

For an Assignment-backed step, persist its bounded final response under the preallocated output ID before committing step success or creating the next agent. Reject blank output. Resolve downstream inputs by their frozen IDs and verify the Assignment revision, Team Run, producing step, role, agent, success state, and descriptor before agent creation. Artifact content is capped at 32 KiB each and 32 KiB total per prompt. Validate that cumulative budget before a supervised dispatch or revision becomes durable; an impossible handoff does not create an attempt, agent, or output reservation. Delimit accepted content as untrusted context with identity, provenance, and truncation facts.

For an objective-only step, delimit the previous response as untrusted handoff context. Cap it at 4 KiB of UTF-8 and state when it was truncated. An empty final response gets an explicit empty marker. Do not pass the full transcript.

The Artifact handoff is not a security or context-isolation boundary. Provider-native launch controls may separately restrict each role. The current real-provider proof covers Codex on macOS. The restricted role uses `sandbox_mode: read-only` with `approval_policy: never`. The writer uses `sandbox_mode: workspace-write` with the same approval policy, no extra writable roots, and both standard temporary-root exclusions. It can write the selected Workspace but not a sibling directory. Both roles can still read the selected Workspace, and daemon tools are not isolated by this boundary. Run records keep step status, timestamps, agent IDs, frozen configuration, and bounded errors; agent timelines remain authoritative for output.

Freeze provider-reported usage on each successful step and sum the additive token and cost fields
in the Team Run projection. Mark omitted provider data `partial` or `unavailable`; never substitute
zero for a value the provider did not report.

## Lifecycle

One foreground stream owns a step from prompt admission through completion, failure, or cancellation.
Register that stream while holding the Workspace operation fence so cancellation cannot observe an
idle agent between the final termination check and prompt admission. A permission request is an
intermediate checkpoint. Persist `waiting_for_permission`, hold the Workspace lock, surface the
ordinary agent permission UI, and resume the same turn after the response. A denied permission is
not itself a failed step; classify the eventual terminal event.

The active step and outer run use the same `waiting_for_permission`, `stopping`, or `stop_failed`
checkpoint. Never persist one side without the other.

Cancellation uses the ordinary agent cancellation path and drains the stream to a terminal event. A refused cancellation is `stop_failed`, remains nonterminal, and retains the Workspace lock.

An unattended deadline uses the same cancellation path, then persists a failed run with an immutable
`deadline` termination record. Check the deadline before external work and before committing a
supervisor decision so a late response cannot cross the boundary. Startup fails already-expired
records before accepting new work and rearms timers only for safe human waits that remain inside
their frozen deadline.

Workspace archive or removal wins over the Team Run. Stop the current step and create no later agents. Keep the preexisting Workspace and every created agent.

Shutdown fences new starts before agents close. Mark in-flight runs interrupted and cancel or settle
them best-effort. Preserve an outer-running, idle `awaiting_human` record only when its request is
unresolved and unretired and no step is active. Startup preserves that same safe wait. Interrupt all
other leftover active runs, including malformed waits and active supervisor or worker turns. Never
replay a prompt whose effects are uncertain.

A terminal supervision phase must match the outer Team Run status. That transition retires any
unresolved human request and settles every unfinished work item in the same atomic run write. The
request remains historical evidence, but it no longer keeps the run or its Workspace and Assignment
locks active. Duplicate supervisor-action retries remain readable after terminalization; new actions
are rejected, and late callbacks cannot rewrite a terminal record.

## Roadmap boundary

Stored v0.2 runs remain objective-only: their Objective is not a durable Assignment and their bounded inline handoff is not an Artifact. [Assignments and Artifacts](assignments.md) own the v0.3 path; stored runs and older clients keep the legacy behavior.

Teams still add no generic policy engine, sandbox, public supervisor flow, failed-attempt retry, fan-out, new scheduler, or Team-owned Workspace creation. The frozen security posture reports provider behavior already selected by the Agent Profile; it does not create a new boundary.
