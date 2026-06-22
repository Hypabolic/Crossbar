import { describe, it, expect } from "vitest";
import { expandHosts, localSubnetCidrs, networkCidr } from "../../src/discovery/subnet.ts";

// ─── expandHosts ──────────────────────────────────────────────────────────────

describe("expandHosts", () => {
  it("expands a /24 to its 254 usable hosts (network + broadcast excluded)", () => {
    const { hosts, truncated } = expandHosts(["10.0.1.0/24"]);
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe("10.0.1.1");
    expect(hosts.at(-1)).toBe("10.0.1.254");
    expect(truncated).toBe(false);
  });

  it("expands a /30 to 2 usable hosts", () => {
    expect(expandHosts(["10.0.1.0/30"]).hosts).toEqual(["10.0.1.1", "10.0.1.2"]);
  });

  it("treats a /32 as a single host", () => {
    expect(expandHosts(["10.0.1.5/32"]).hosts).toEqual(["10.0.1.5"]);
  });

  it("expands a last-octet range", () => {
    expect(expandHosts(["10.0.1.10-12"]).hosts).toEqual(["10.0.1.10", "10.0.1.11", "10.0.1.12"]);
  });

  it("passes plain hosts and hostnames through unchanged", () => {
    expect(expandHosts(["192.168.1.50", "nas.local"]).hosts).toEqual(["192.168.1.50", "nas.local"]);
  });

  it("de-duplicates across specs", () => {
    const { hosts } = expandHosts(["10.0.1.1", "10.0.1.0/30"]);
    expect(hosts).toEqual(["10.0.1.1", "10.0.1.2"]);
  });

  it("caps the total and reports truncation", () => {
    const { hosts, truncated } = expandHosts(["10.0.0.0/16"], 10);
    expect(hosts).toHaveLength(10);
    expect(truncated).toBe(true);
  });

  it("drops malformed CIDRs rather than probing a bogus origin", () => {
    expect(expandHosts(["10.0.1.0/99"]).hosts).toEqual([]);
    expect(expandHosts(["999.1.1.1/24"]).hosts).toEqual([]);
  });

  it("ignores blank specs", () => {
    expect(expandHosts(["", "  ", "10.0.1.5"]).hosts).toEqual(["10.0.1.5"]);
  });
});

// ─── networkCidr ──────────────────────────────────────────────────────────────

describe("networkCidr", () => {
  it("masks an interface address to its network CIDR", () => {
    expect(networkCidr("10.0.0.72/24")).toBe("10.0.0.0/24");
    expect(networkCidr("192.168.1.130/26")).toBe("192.168.1.128/26");
  });
  it("returns null for malformed input", () => {
    expect(networkCidr("not-a-cidr")).toBeNull();
    expect(networkCidr("10.0.0.1/40")).toBeNull();
  });
});

// ─── localSubnetCidrs ─────────────────────────────────────────────────────────

type Ifaces = Parameters<typeof localSubnetCidrs>[0];

describe("localSubnetCidrs", () => {
  it("returns the network CIDR of a private, non-internal IPv4 interface", () => {
    const ifaces = {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }],
      en0: [{ address: "10.0.0.72", family: "IPv4", internal: false, cidr: "10.0.0.72/24" }],
    } as unknown as Ifaces;
    expect(localSubnetCidrs(ifaces)).toEqual(["10.0.0.0/24"]);
  });

  it("accepts the numeric family form and de-duplicates shared subnets", () => {
    const ifaces = {
      en1: [{ address: "10.0.0.72", family: 4, internal: false, cidr: "10.0.0.72/24" }],
      en2: [{ address: "10.0.0.63", family: 4, internal: false, cidr: "10.0.0.63/24" }],
    } as unknown as Ifaces;
    expect(localSubnetCidrs(ifaces)).toEqual(["10.0.0.0/24"]);
  });

  it("skips internal, IPv6, public, and over-broad interfaces", () => {
    const ifaces = {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }],
      en0: [{ address: "fe80::1", family: "IPv6", internal: false, cidr: "fe80::1/64" }],
      en1: [{ address: "203.0.113.5", family: "IPv4", internal: false, cidr: "203.0.113.5/24" }], // public
      vpn: [{ address: "10.5.0.2", family: "IPv4", internal: false, cidr: "10.5.0.2/8" }], // too broad (<22)
    } as unknown as Ifaces;
    expect(localSubnetCidrs(ifaces)).toEqual([]);
  });
});
