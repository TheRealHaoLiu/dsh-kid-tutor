import { describe, expect, it } from "vitest";
import { checkFetchUrl, isAllowedHost, isDisallowedHost } from "../src/net.ts";

const ALLOWLIST = ["en.wikipedia.org", "docs.python.org"];

describe("isDisallowedHost", () => {
  it("denies literal IPv4 loopback and RFC1918", () => {
    expect(isDisallowedHost("127.0.0.1")).toBe(true);
    expect(isDisallowedHost("10.0.0.5")).toBe(true);
    expect(isDisallowedHost("172.16.0.1")).toBe(true);
    expect(isDisallowedHost("172.31.255.255")).toBe(true);
    expect(isDisallowedHost("192.168.1.1")).toBe(true);
    expect(isDisallowedHost("169.254.1.1")).toBe(true);
  });

  it("allows a public IPv4-shaped literal through the IP check (allowlist still applies separately)", () => {
    expect(isDisallowedHost("8.8.8.8")).toBe(false);
    // Not RFC1918: 172.15.x and 172.32.x are outside the 172.16/12 block.
    expect(isDisallowedHost("172.15.0.1")).toBe(false);
    expect(isDisallowedHost("172.32.0.1")).toBe(false);
  });

  it("denies IPv6 loopback, link-local, and unique-local", () => {
    expect(isDisallowedHost("::1")).toBe(true);
    expect(isDisallowedHost("fe80::1")).toBe(true);
    expect(isDisallowedHost("fc00::1")).toBe(true);
    expect(isDisallowedHost("fd12:3456::1")).toBe(true);
  });

  it("denies IPv4-mapped IPv6 private addresses", () => {
    expect(isDisallowedHost("::ffff:127.0.0.1")).toBe(true);
    expect(isDisallowedHost("::ffff:192.168.1.1")).toBe(true);
  });

  it("denies localhost and reserved local suffixes", () => {
    expect(isDisallowedHost("localhost")).toBe(true);
    expect(isDisallowedHost("router.local")).toBe(true);
    expect(isDisallowedHost("nas.lan")).toBe(true);
    expect(isDisallowedHost("box.home")).toBe(true);
    expect(isDisallowedHost("svc.internal")).toBe(true);
  });

  it("allows an ordinary public hostname", () => {
    expect(isDisallowedHost("en.wikipedia.org")).toBe(false);
  });
});

describe("isAllowedHost", () => {
  it("matches exact and subdomain entries", () => {
    expect(isAllowedHost("en.wikipedia.org", ALLOWLIST)).toBe(true);
    expect(isAllowedHost("m.en.wikipedia.org", ALLOWLIST)).toBe(true);
    expect(isAllowedHost("docs.python.org", ALLOWLIST)).toBe(true);
  });

  it("rejects a non-matching host and a suffix-only lookalike", () => {
    expect(isAllowedHost("evil-en.wikipedia.org.attacker.com", ALLOWLIST)).toBe(false);
    expect(isAllowedHost("notwikipedia.org", ALLOWLIST)).toBe(false);
  });
});

describe("checkFetchUrl", () => {
  it("passes an allowlisted https URL", () => {
    expect(checkFetchUrl("https://en.wikipedia.org/wiki/Volcano", ALLOWLIST)).toEqual({ ok: true });
  });

  it("rejects a non-allowlisted host", () => {
    const result = checkFetchUrl("https://example.com", ALLOWLIST);
    expect(result.ok).toBe(false);
  });

  it("rejects a private-network target even if somehow allowlisted", () => {
    const result = checkFetchUrl("http://192.168.1.1/", ["192.168.1.1"]);
    expect(result.ok).toBe(false);
  });

  it("rejects non-http(s) schemes", () => {
    const result = checkFetchUrl("file:///etc/passwd", ALLOWLIST);
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed URL", () => {
    const result = checkFetchUrl("not a url", ALLOWLIST);
    expect(result.ok).toBe(false);
  });
});
