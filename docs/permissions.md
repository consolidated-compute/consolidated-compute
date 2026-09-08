# Daemon permissions

The daemon authorizes principals with semantic permissions. RPC names and protocol namespaces are not authority.

## Model

```text
principal -> grants
    |
    +-- authenticated by a device or service credential
    `-- opens a session with equal or narrower authority
```

A principal is the durable identity the daemon authorizes. A credential proves that a device or service represents it. Keep them separate so you can rotate credentials, attach more than one device, and revoke a Hub user without inventing daemon user accounts.

A pairing invitation is neither. It is an expiring, single-use exchange that creates a principal and credential with the permissions selected by its issuer.

## Device enrollment rollout

Device enrollment is not exposed in the client UI yet. Existing installations keep their daemon-password policy; relay pairing still exchanges connection information rather than enrolling a device. Do not remove the supervised Team password requirement based on the presence of device records.

The daemon enforces an explicit device-authentication opt-in across protected HTTP, direct WebSocket, and decrypted relay sockets. Direct clients can send the credential as a bearer subprotocol; relay clients must put `deviceCredential` in the encrypted hello, never in headers sent to the relay. Missing or revoked credentials do not fall back to password or anonymous owner access. Hub and in-process plugin sessions retain their independent admission paths. Agent MCP retains its internal capabilities; a device credential does not grant the unscoped MCP catalog.

The SDK accepts `deviceCredential` independently of `password` and `authHeader`; combining them is a configuration error. For relay URLs, supply `e2ee.enabled` and the daemon public key from the connection offer. The SDK carries the credential inside the encrypted channel and rejects device connections to a relay without encryption. It requires the daemon's runtime `deviceAuthentication` acknowledgement before releasing queued requests, so an older passwordless daemon cannot silently admit this client anonymously. It does not enroll or persist credentials for you.

Activation records the opt-in separately in `device-authentication.json`, after an enrolled credential has `access.manage`. Enrollment alone does not opt in. Losing `device-access.json` after activation is a storage failure, not permission to recreate an empty registry or admit anonymous clients. Revoking the final credential does not disable authentication. Bootstrap approval must come from a trusted local path, never from an anonymous socket requesting owner authority. Activation, client credential storage, and recovery UI remain unimplemented; do not manually opt in a production host whose clients cannot reconnect with device credentials.

Authority changes close user sockets and in-flight HTTP responses, including connections admitted before activation. Clients reconnect to obtain current grants; the daemon does not retain their plaintext credential after the handshake. In device mode, file downloads require both the device's `workspace.read` grant and the existing download capability. HTTP status requires `daemon.read`; new HTTP routes must declare their authority rather than inheriting a blanket allow. These checks do not revoke work already accepted before an authority change.

One daemon process owns device-store mutations. Future CLI and desktop adapters must route changes through that owner rather than opening concurrent file writers. Clients retain their generated credential before redeeming an invitation so a lost enrollment response can be retried without storing plaintext credentials on the daemon.

Device credentials identify approved clients. They do not isolate provider processes running as the same OS user, which may read client storage or modify daemon files. Credential storage and provider isolation need separate threat models.

## Permissions

| Permission          | Authority                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `daemon.read`       | Daemon status, diagnostics, configuration, and provider information                                       |
| `daemon.manage`     | Restart, update, configuration changes, providers, skills, and plugins                                    |
| `tunnel.manage`     | Relay, Hub, service tunnel, and public endpoint relationships                                             |
| `access.manage`     | Pairing invitations, principals, credentials, grants, and revocation                                      |
| `workspace.read`    | Projects, workspaces, agents, Teams, Assignments, Artifacts, timelines, files, diffs, and terminal output |
| `workspace.write`   | Prompts, agent and Team Run control, Assignment mutations, files, terminals, git operations, and scripts  |
| `workspace.manage`  | Create, rename, archive, and remove projects and workspaces                                               |
| `automation.manage` | Schedules, heartbeats, and loops                                                                          |
| `hub.execute`       | The Hub-owned execution lifecycle                                                                         |

Agents and terminals use workspace authority. Both can execute code and mutate the workspace, so separate write permissions would claim an isolation boundary the daemon cannot enforce.

Owner, operator, and viewer are UI presets expanded into explicit permissions. Do not persist them as roles. Adding a permission must not silently widen an existing principal.

Permissions are additive allows. Missing authority denies the operation. Do not add deny precedence.

## Resources

Permissions are daemon-wide today. Future grants may select workspaces or agents, but operation classification remains inside the authorization module:

```ts
type Grant = {
  permission: Permission;
  resource: { kind: "daemon" } | { kind: "workspace"; ids: string[] };
};
```

A delegating principal can grant only authority it already possesses. A session may attenuate its principal's grants but cannot widen them.

Workspace-scoped grants require every resource-bearing operation and outbound observation to enforce the same workspace boundary. File preview currently accepts any daemon-readable regular file, so it must gain resource enforcement before workspace-specific access ships.

## Hub

The Hub authenticates as a service principal. Its locally selected grants decide whether it may execute agents, manage the daemon, manage tunnels, or manage access.

Hub user and role identifiers remain opaque external subjects. The Hub may create and revoke linked daemon principals when granted `access.manage`; the daemon does not interpret accounts, organizations, or roles.

Hub enrollment and permission updates exchange these semantic permissions directly. Legacy persisted Hub relationships that contain `hub.execution.*` migrate once to `hub.execute` when the daemon loads them; new relationships never persist or emit transport scopes as authority.
