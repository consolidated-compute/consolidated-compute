import { describe, expect, test } from "vitest";
import {
  GetProvidersSnapshotResponseMessageSchema,
  ProviderSnapshotEntrySchema,
  ProvidersSnapshotUpdateMessageSchema,
} from "./messages.js";

describe("provider snapshot message schemas", () => {
  test("defaults missing provider snapshot entry enabled state to true", () => {
    const parsed = ProviderSnapshotEntrySchema.parse({
      provider: "codex",
      status: "ready",
      label: "Codex",
    });

    expect(parsed.enabled).toBe(true);
  });

  test("preserves disabled provider snapshot entries", () => {
    const parsed = ProviderSnapshotEntrySchema.parse({
      provider: "claude",
      status: "unavailable",
      enabled: false,
      label: "Claude",
    });

    expect(parsed.enabled).toBe(false);
  });

  test("preserves enabled provider snapshot entries", () => {
    const parsed = ProviderSnapshotEntrySchema.parse({
      provider: "opencode",
      status: "loading",
      enabled: true,
      label: "OpenCode",
    });

    expect(parsed.enabled).toBe(true);
  });

  test("preserves provider snapshot entry source", () => {
    const parsed = ProviderSnapshotEntrySchema.parse({
      provider: "gemini",
      status: "ready",
      enabled: true,
      source: "custom",
      label: "Gemini",
    });

    expect(parsed.source).toBe("custom");
  });

  test("preserves bounded Agent Profile security presets", () => {
    const parsed = ProviderSnapshotEntrySchema.parse({
      provider: "codex",
      status: "ready",
      enabled: true,
      agentProfileSecurityPresets: [
        {
          id: "fail-closed-read-only",
          label: "Fail-closed read only",
          description: "Deny writes and approval escapes.",
          providerOptions: {
            approval_policy: "never",
            sandbox_mode: "read-only",
          },
        },
      ],
    });

    expect(parsed.agentProfileSecurityPresets).toEqual([
      {
        id: "fail-closed-read-only",
        label: "Fail-closed read only",
        description: "Deny writes and approval escapes.",
        providerOptions: {
          approval_policy: "never",
          sandbox_mode: "read-only",
        },
      },
    ]);
  });

  test("rejects oversized Agent Profile security preset catalogs", () => {
    const presets = Array.from({ length: 13 }, (_, index) => ({
      id: `preset-${index}`,
      label: `Preset ${index}`,
      providerOptions: {},
    }));

    expect(() =>
      ProviderSnapshotEntrySchema.parse({
        provider: "codex",
        status: "ready",
        agentProfileSecurityPresets: presets,
      }),
    ).toThrow();
  });

  test("defaults missing enabled state in providers snapshot response entries", () => {
    const parsed = GetProvidersSnapshotResponseMessageSchema.parse({
      type: "get_providers_snapshot_response",
      payload: {
        entries: [
          {
            provider: "codex",
            status: "ready",
            label: "Codex",
          },
          {
            provider: "claude",
            status: "unavailable",
            enabled: false,
            label: "Claude",
          },
        ],
        generatedAt: "2026-04-24T00:00:00.000Z",
        requestId: "req-providers",
      },
    });

    expect(parsed.payload.entries.map((entry) => entry.enabled)).toEqual([true, false]);
  });

  test("defaults missing enabled state in providers snapshot update entries", () => {
    const parsed = ProvidersSnapshotUpdateMessageSchema.parse({
      type: "providers_snapshot_update",
      payload: {
        cwd: "/tmp/repo",
        entries: [
          {
            provider: "codex",
            status: "ready",
            label: "Codex",
          },
        ],
        generatedAt: "2026-04-24T00:00:00.000Z",
      },
    });

    expect(parsed.payload.entries[0]?.enabled).toBe(true);
  });
});
