# Assignments and Artifacts

An Assignment is durable execution intent owned by one daemon. An Artifact is one bounded result produced for an accepted Assignment revision. A Work Item is an optional link to intent owned by another system.

## Ownership

Assignment and Artifact IDs are daemon-local. The app qualifies them with `serverId`; stored and wire records do not.

The daemon owns the Assignment title, objective, link, and lifecycle. It does not own the linked Work Item or infer its state. Team Runs and Artifacts keep the accepted Assignment ID and revision so later edits cannot rewrite history.

Disk schemas belong to the server. Future protocol DTOs project those records without exporting persistence schemas.

## Work Item references

A Work Item reference keeps source and resource identity, a URL, and bounded display fallbacks. The title, identifier, source label, and URL are snapshots revised with the Assignment. The external source remains authoritative.

Do not store the Work Item body, comments, labels, assignees, status, or lifecycle. Do not fetch live Work Item content implicitly when a run starts. If an agent needs bounded external content, capture it explicitly as an Artifact.

Several Assignments may link to the same Work Item. The reference is context, not a uniqueness key or synchronization contract.

## Assignment lifecycle

An Assignment is `open`, `completed`, or `canceled`. Active execution is derived from Team Runs and is never duplicated on the Assignment.

Open Assignment edits increment its optimistic revision. A run freezes the complete accepted revision, so later edits affect only future admissions. Editing an open Assignment while a run is active is allowed. Completing or canceling it while a run is active is not.

Run success does not complete the Assignment or update the Work Item. Those are separate user decisions. Terminal Assignments, runs, and Artifacts remain readable; v0.3 has no hard delete.

The first contract permits one active Team Run per Assignment. Multiple concurrent runs require an explicit lineage model before they can share Artifact inputs safely.

## Artifacts

An Artifact is immutable and append-only. It records:

- one Assignment ID and accepted revision;
- an open lowercase kind token and title;
- inline `text/markdown` content;
- the producing Team Run, step, role, agent, and optional provider turn;
- creation time and UTF-8 inclusion/truncation facts.

Artifact content is nonempty and capped at 32 KiB of UTF-8. Truncation never splits a code point and records the original and included byte counts. Corrections create another Artifact. Artifact creation does not increment the Assignment revision.

Kinds such as `plan`, `research`, `implementation_summary`, `review`, `test_result`, `decision`, and `approval` are conventions, not a closed enum. Consumers must display unknown kinds.

V0.3 has no binary, image, path-backed, update, or delete contract. In code, qualify the durable noun as `AssignmentArtifact`; the existing `ArtifactMessageSchema` is an unrelated transient agent message.

## Team Run boundary

Assignment-backed admission atomically validates the expected Team and Assignment revisions, open lifecycle, active-run exclusion, Workspace lock, and idempotency inputs. The run freezes the Assignment snapshot and retains the existing `objective` field as its compatibility projection.

The initial sequential plan preallocates one output Artifact identity per step. Each later step freezes the immediately preceding output ID as its only Artifact input. Team definitions do not gain required Artifact fields; older apps must remain able to edit a Team without erasing execution semantics.

On successful turn completion:

1. Materialize the bounded final response under the preallocated Artifact ID.
2. Persist it idempotently.
3. Commit step success and activate the next step.
4. Start the next prompt from its frozen input IDs.

Never resolve the latest Artifact for an Assignment. A retry or another run must not change historical input selection.

A crash before Artifact persistence leaves no output. A crash after persistence retains the Artifact, interrupts uncertain run work on startup, and never launches a consumer without durable input. Duplicate completion returns the same Artifact rather than allocating another ID.

Existing objective-only Team Runs keep their bounded previous-response handoff as a compatibility path. New clients use a capability-gated Assignment start and never fall back silently. See [teams.md](teams.md) for the current Team lifecycle.

## Trust boundary

Artifact content is delimited untrusted prompt context, not instructions. It is not a transcript, memory system, approval authority, or security boundary. Roles still share the Workspace filesystem and may use daemon tools. Agent timelines remain authoritative for complete output.
