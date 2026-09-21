/**
 * Reverse-DNS hostname retry for SNI-strict HTTPS backends.
 *
 * When an HTTPS origin is probed by bare IP and the server aborts the TLS handshake
 * (e.g. a reverse proxy that demands a specific SNI hostname), discovery reverse-resolves
 * the IP and retries with the hostname so the correct SNI is sent. These tests drive that
 * path through the real `probeOrigin` selection logic with a fake probe + mocked reverse DNS.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock reverse DNS so no real lookup happens.
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, reverse: vi.fn() };
});

const { probeOrigin } = await import("../../src/discovery/engine.ts");
const { clearCache } = await import("../../src/discovery/dns.ts");
const reverseMock = vi.mocked(await import("node:dns/promises")).reverse;

import type { BackendAdapter } from "../../src/core/backend-adapter.ts";
import type { DiscoveredServer, Probe, ProbeResult } from "../../src/core/types.ts";
import type { ProbeFactory } from "../../src/discovery/engine.ts";
import { Capability } from "../../src/core/capability.ts";

function makeAdapter(
  kind: BackendAdapter["kind"],
  fingerprint: (baseUrl: string, probe: Probe) => Promise<DiscoveredServer | null>,
): BackendAdapter {
  return {
    kind,
    displayName: kind,
    defaultPorts: [],
    piApi: "openai-completions",
    capabilities: new Set<Capability>([Capability.ListModels]),
    fingerprint,
    listModels: async () => [],
    toPiModel: () => ({
      id: "m",
      name: "m",
      contextWindow: 4096,
      maxTokens: 512,
      input: ["text"],
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    inferenceBaseUrl: (s) => `${s.baseUrl}/v1`,
  };
}

const handshakeReject: ProbeResult = {
  status: 0,
  ok: false,
  headers: {},
  error: "tlsv1 alert internal error",
  tlsHandshakeError: true,
};

const okJson: ProbeResult = {
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  text: "{}",
  json: {},
};

beforeEach(() => {
  clearCache();
  reverseMock.mockReset();
});

describe("probeOrigin — reverse-DNS hostname retry", () => {
  it("retries an SNI-rejected IP via its reverse hostname and surfaces the hostname URL", async () => {
    reverseMock.mockResolvedValue(["guru.fritz.box"]);

    // Adapter matches ONLY when it can read a 200 body (i.e. the hostname connection succeeds).
    const adapter = makeAdapter("llamacpp", async (baseUrl, probe) => {
      const r = await probe("/");
      if (r.status !== 200) return null;
      return {
        kind: "llamacpp" as const,
        baseUrl,
        auth: "none" as const,
        label: "llama.cpp",
        confidence: 0.9,
      };
    });

    // IP origin: every probe handshake-rejects. Hostname origin: probes succeed (200).
    // Note: URL normalisation drops the default :443, so the hostname URL is scheme+host only.
    const factory: ProbeFactory = (target) => async (): Promise<ProbeResult> =>
      target.includes("guru.fritz.box") ? okJson : handshakeReject;

    const result = await probeOrigin(
      "https://192.168.188.102:443",
      [adapter],
      1000,
      factory,
      false,
    );

    expect(result).not.toBeNull();
    expect(result?.kind).toBe("llamacpp");
    expect(result?.baseUrl).toBe("https://guru.fritz.box");
    expect(reverseMock).toHaveBeenCalledWith("192.168.188.102");
  });

  it("drops an SNI-rejected IP when reverse DNS yields nothing", async () => {
    reverseMock.mockRejectedValue(new Error("no PTR"));

    const adapter = makeAdapter("llamacpp", async () => null);
    const factory: ProbeFactory = () => async (): Promise<ProbeResult> => handshakeReject;

    const result = await probeOrigin(
      "https://192.168.188.102:443",
      [adapter],
      1000,
      factory,
      false,
    );

    expect(result).toBeNull();
  });

  it("drops an SNI-rejected IP whose hostname is not an LLM backend", async () => {
    reverseMock.mockResolvedValue(["printer.fritz.box"]);

    // Never matches, even once reachable by hostname -> not a backend.
    const adapter = makeAdapter("llamacpp", async () => null);
    const factory: ProbeFactory = (target) => async (): Promise<ProbeResult> =>
      target.includes("printer.fritz.box") ? okJson : handshakeReject;

    const result = await probeOrigin(
      "https://192.168.188.102:443",
      [adapter],
      1000,
      factory,
      false,
    );

    expect(result).toBeNull();
  });
});
