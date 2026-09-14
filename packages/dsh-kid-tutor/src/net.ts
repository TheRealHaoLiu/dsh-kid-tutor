/**
 * Pure hostname/URL classification for `tool-policy`'s `web_fetch` guard.
 * `@deepseek-ai/dsh-web-fetch-http` "is an SSRF primitive and must not be
 * enabled in a deployment that can reach sensitive internal network targets"
 * (its own README) — this module is the allowlist-plus-safety check that
 * makes enabling it acceptable for a homelab host per docs/dsh-seams.md §0.2.
 *
 * @module dsh-kid-tutor/net
 */

import { isIP } from "node:net";

const DISALLOWED_SUFFIXES = [".local", ".lan", ".home", ".internal"];

/** Reserved suffix labels that resolve to the local host regardless of DNS. */
const LOCALHOST_LABELS = new Set(["localhost"]);

/**
 * Whether an IPv4 dotted-quad falls in a loopback, link-local, or RFC1918
 * private range. Takes pre-split octet numbers (0-255 unchecked here; `isIP`
 * already proved the string is a well-formed IPv4 literal before this runs).
 */
function isPrivateOrLoopbackIPv4(octets: readonly number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  return false;
}

/** Whether an IPv6 literal is loopback, link-local, or a unique-local (fc00::/7) address. */
function isPrivateOrLoopbackIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized === "::") return true; // unspecified
  if (normalized.startsWith("fe80:") || normalized.startsWith("fe80::")) return true; // link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local fc00::/7
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — classify by the embedded IPv4.
  const mapped = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (mapped) {
    const octets = mapped.slice(1, 5).map((part) => Number.parseInt(part, 10));
    return isPrivateOrLoopbackIPv4(octets);
  }
  return false;
}

/**
 * Whether `hostname` (as returned by `new URL(...).hostname`, i.e. already
 * lowercased and bracket-stripped for IPv6) must be denied regardless of the
 * allowlist: a literal IP, a reserved local suffix, or `localhost` itself.
 */
export function isDisallowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOCALHOST_LABELS.has(host)) return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const octets = host.split(".").map((part) => Number.parseInt(part, 10));
    return isPrivateOrLoopbackIPv4(octets);
  }
  if (ipVersion === 6) {
    return isPrivateOrLoopbackIPv6(host);
  }
  return DISALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Whether `hostname` exactly matches or is a subdomain of an allowlisted entry. */
export function isAllowedHost(hostname: string, allowlist: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowlist.some((entry) => {
    const allowed = entry.toLowerCase();
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

export type UrlCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Full `web_fetch` URL check: well-formed http(s) URL, host not disallowed by
 * IP/RFC1918/loopback/link-local/suffix rules, host on the allowlist.
 */
export function checkFetchUrl(rawUrl: string, allowlist: readonly string[]): UrlCheckResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "that does not look like a valid web address" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "only http and https addresses are allowed" };
  }
  if (isDisallowedHost(url.hostname)) {
    return { ok: false, reason: "that address points at a private or local network, which is never allowed" };
  }
  if (!isAllowedHost(url.hostname, allowlist)) {
    return { ok: false, reason: `"${url.hostname}" is not one of the approved websites` };
  }
  return { ok: true };
}
