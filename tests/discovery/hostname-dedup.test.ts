/**
 * Tests for the hostname+port deduplication logic in the discovery engine.
 *
 * dedupByHostname is async — it resolves unresolved IPs internally so that
 * multiple IPs of the same machine collapse to a single hostname entry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DiscoveredServer } from "../../src/core/types.ts";
import { dedupByHostname } from "../../src/discovery/engine.ts";

// ---------------------------------------------------------------------------
// Mock dns.reverse — avoid real DNS
// ---------------------------------------------------------------------------

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    reverse: vi.fn(actual.reverse),
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    hostname: vi.fn(actual.hostname),
  };
});

const mockHostname = vi.mocked((await import("node:os")).hostname);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(baseUrl: string): DiscoveredServer {
  return {
    baseUrl,
    label: `Server (${new URL(baseUrl).hostname}:${new URL(baseUrl).port})`,
    kind: "omlx",
    health: { status: "ok", latencyMs: 10 },
  } as unknown as DiscoveredServer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dedupByHostname", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Local machine is on .local domain
    mockHostname.mockReturnValue("workstation.local");
    // Clear DNS cache between tests
    const { clearCache } = await import("../../src/discovery/dns.ts");
    clearCache();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps single entry unchanged", async () => {
    const servers = [makeServer("http://workstation.local:8000")];
    const result = await dedupByHostname(servers);
    expect(result).toHaveLength(1);
    expect(result[0]!.baseUrl).toBe("http://workstation.local:8000");
  });

  it("keeps different hostnames on same port", async () => {
    const servers = [
      makeServer("http://workstation.local:8000"),
      makeServer("http://devbox.local:8000"),
    ];
    const result = await dedupByHostname(servers);
    expect(result).toHaveLength(2);
  });

  it("same hostname different ports — both kept", async () => {
    const servers = [
      makeServer("http://workstation.local:8000"),
      makeServer("http://workstation.local:11434"),
    ];
    const result = await dedupByHostname(servers);
    expect(result).toHaveLength(2);
  });

  it("resolves multiple IPs to same hostname — collapses to one", async () => {
    // All three IPs resolve to the same hostname
    vi.mocked(await import("node:dns/promises")).reverse.mockResolvedValue(["workstation.local"]);

    const servers = [
      makeServer("http://192.168.188.127:8000"),
      makeServer("http://192.168.139.3:8000"),
      makeServer("http://workstation.local:8000"), // already resolved
    ];
    const result = await dedupByHostname(servers);
    expect(result).toHaveLength(1);
    // URL constructor adds trailing slash for empty paths
    expect(result[0]!.baseUrl.replace(/\/$/, "")).toBe("http://workstation.local:8000");
  });

  it("one IP resolves to hostname — preferred over unresolved IP", async () => {
    const mockReverse = vi.mocked(await import("node:dns/promises")).reverse;
    // First IP resolves, second doesn't
    mockReverse
      .mockResolvedValueOnce(["workstation.local"])
      .mockRejectedValueOnce(new Error("not found"));

    const servers = [
      makeServer("http://10.0.0.5:8000"),       // resolves to workstation.local
      makeServer("http://10.0.0.6:8000"),       // fails to resolve
      makeServer("http://workstation.local:8000"), // already hostname
    ];
    const result = await dedupByHostname(servers);
    // Two groups: workstation.local:8000 (2 entries) and 10.0.0.6:8000 (1 entry)
    expect(result).toHaveLength(2);
    // The workstation.local entry is preferred over the unresolved 10.0.0.5
    const hostnameEntry = result.find((s) => s.baseUrl.includes("workstation.local"));
    expect(hostnameEntry).toBeDefined();
  });

  it("all IPs unresolved and different — keeps first in each group", async () => {
    vi.mocked(await import("node:dns/promises")).reverse.mockRejectedValue(new Error("fail"));
    const servers = [
      makeServer("http://192.168.188.127:8000"),
      makeServer("http://192.168.139.3:8000"),
    ];
    const result = await dedupByHostname(servers);
    // Different IPs, different keys — both kept
    expect(result).toHaveLength(2);
  });

  it("localhost and hostname on same port — both kept (different keys)", async () => {
    const servers = [
      makeServer("http://127.0.0.1:8000"),
      makeServer("http://workstation.local:8000"),
    ];
    const result = await dedupByHostname(servers);
    expect(result).toHaveLength(2);
  });

  it("labels use short hostname (domain suffix stripped)", async () => {
    vi.mocked(await import("node:dns/promises")).reverse.mockResolvedValue(
      ["workstation.local"],
    );
    const servers = [
      makeServer("http://192.168.188.127:8000"),
    ];
    const result = await dedupByHostname(servers);
    expect(result).toHaveLength(1);
    // Label should show "workstation" not "workstation.local"
    expect(result[0]!.label).toContain("workstation:");
    expect(result[0]!.label).not.toContain(".local");
  });
});
