/**
 * Unit tests for the DNS hostname resolution module.
 *
 * Tests resolveHostname(), resolveUrlHostname(), and caching behaviour.
 * Real DNS lookups are avoided by mocking node:dns/promises.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reverse } from "node:dns/promises";

// ---------------------------------------------------------------------------
// Mock dns.reverse — real DNS is slow and unreliable in CI
// ---------------------------------------------------------------------------

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    reverse: vi.fn(actual.reverse),
  };
});

const mockReverse = vi.mocked(reverse);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dns resolveHostname", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("localhost: returns IP unchanged", async () => {
    const { resolveHostname } = await import("../../src/discovery/dns.ts");
    expect(await resolveHostname("localhost")).toBe("localhost");
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it("127.0.0.1: returns IP unchanged", async () => {
    const { resolveHostname } = await import("../../src/discovery/dns.ts");
    expect(await resolveHostname("127.0.0.1")).toBe("127.0.0.1");
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it("IPv6: returns IP unchanged", async () => {
    const { resolveHostname } = await import("../../src/discovery/dns.ts");
    expect(await resolveHostname("::1")).toBe("::1");
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it("IPv6 full address: returns IP unchanged", async () => {
    const { resolveHostname } = await import("../../src/discovery/dns.ts");
    expect(await resolveHostname("2001:db8::1")).toBe("2001:db8::1");
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it("resolves a real IP to hostname", async () => {
    mockReverse.mockResolvedValue(["workstation.local"]);
    const { resolveHostname } = await import("../../src/discovery/dns.ts");
    expect(await resolveHostname("192.168.1.42")).toBe("workstation.local");
    expect(mockReverse).toHaveBeenCalledWith("192.168.1.42");
  });

  it("falls back to original IP on DNS failure", async () => {
    mockReverse.mockRejectedValue(new Error("DNS lookup failed"));
    const { resolveHostname } = await import("../../src/discovery/dns.ts");
    expect(await resolveHostname("10.0.0.5")).toBe("10.0.0.5");
  });

  it("falls back to original IP when reverse returns empty array", async () => {
    mockReverse.mockResolvedValue([]);
    const { resolveHostname } = await import("../../src/discovery/dns.ts");
    expect(await resolveHostname("10.0.0.5")).toBe("10.0.0.5");
  });

  it("caches result — second call with same IP returns cached value", async () => {
    mockReverse.mockResolvedValue(["cache-test.local"]);
    const { resolveHostname } = await import("../../src/discovery/dns.ts");
    expect(await resolveHostname("172.16.0.1")).toBe("cache-test.local");
    expect(mockReverse).toHaveBeenCalledTimes(1);
    // Second call should reuse cache — no additional DNS call
    expect(await resolveHostname("172.16.0.1")).toBe("cache-test.local");
    expect(mockReverse).toHaveBeenCalledTimes(1);
  });

  it("clearCache clears the internal cache", async () => {
    mockReverse.mockResolvedValue(["first.local"]);
    const { resolveHostname, clearCache } = await import("../../src/discovery/dns.ts");
    expect(await resolveHostname("10.1.1.1")).toBe("first.local");
    clearCache();
    mockReverse.mockResolvedValue(["second.local"]);
    expect(await resolveHostname("10.1.1.1")).toBe("second.local");
    expect(mockReverse).toHaveBeenCalledTimes(2);
  });
});

describe("dns resolveUrlHostname", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { clearCache } = await import("../../src/discovery/dns.ts");
    clearCache();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("localhost: returns URL unchanged", async () => {
    const { resolveUrlHostname } = await import("../../src/discovery/dns.ts");
    expect(await resolveUrlHostname("http://localhost:8000/v1")).toBe(
      "http://localhost:8000/v1",
    );
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it("127.0.0.1: returns URL unchanged", async () => {
    const { resolveUrlHostname } = await import("../../src/discovery/dns.ts");
    expect(await resolveUrlHostname("http://127.0.0.1:11434")).toBe(
      "http://127.0.0.1:11434",
    );
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it("resolves IP in URL to hostname", async () => {
    mockReverse.mockResolvedValue(["workstation.local"]);
    const { resolveUrlHostname } = await import("../../src/discovery/dns.ts");
    // URL constructor adds trailing slash for paths; normalize in comparison
    const result = await resolveUrlHostname("http://192.168.1.42:11434");
    expect(result).toMatch(/^http:\/\/workstation\.local:11434(\/)?$/);
  });

  it("preserves path, query, and hash", async () => {
    mockReverse.mockResolvedValue(["dev.local"]);
    const { resolveUrlHostname } = await import("../../src/discovery/dns.ts");
    const result = await resolveUrlHostname("http://10.0.0.5:8000/v1/models?key=val#top");
    expect(result).toBe("http://dev.local:8000/v1/models?key=val#top");
  });

  it("falls back to original URL on DNS failure", async () => {
    mockReverse.mockRejectedValue(new Error("DNS failed"));
    const { resolveUrlHostname } = await import("../../src/discovery/dns.ts");
    expect(await resolveUrlHostname("http://10.0.0.5:8000")).toBe(
      "http://10.0.0.5:8000",
    );
  });

  it("malformed URL returns original", async () => {
    const { resolveUrlHostname } = await import("../../src/discovery/dns.ts");
    expect(await resolveUrlHostname("not-a-url")).toBe("not-a-url");
  });

  it("caches hostname resolution across multiple URLs", async () => {
    mockReverse.mockResolvedValue(["shared.local"]);
    const { resolveUrlHostname } = await import("../../src/discovery/dns.ts");
    await resolveUrlHostname("http://172.16.0.1:8000");
    await resolveUrlHostname("http://172.16.0.1:11434");
    // Only one DNS call despite two URLs with same IP
    expect(mockReverse).toHaveBeenCalledTimes(1);
  });
});
