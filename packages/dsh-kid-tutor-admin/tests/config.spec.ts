import { describe, expect, it } from "vitest";
import { dayKey, formatTimestamp, resolveSince } from "../src/config.ts";

describe("resolveSince", () => {
  const now = new Date("2026-09-14T12:00:00.000Z").valueOf();

  it("parses a relative hour duration", () => {
    expect(resolveSince("24h", "7d", now)).toBe(now - 24 * 3_600_000);
  });

  it("parses a relative day duration", () => {
    expect(resolveSince("7d", "24h", now)).toBe(now - 7 * 86_400_000);
  });

  it("parses a relative minute duration", () => {
    expect(resolveSince("90m", "24h", now)).toBe(now - 90 * 60_000);
  });

  it("parses an absolute ISO timestamp", () => {
    expect(resolveSince("2026-09-01T00:00:00.000Z", "24h", now)).toBe(
      new Date("2026-09-01T00:00:00.000Z").valueOf(),
    );
  });

  it("falls back to defaultSince when since is omitted", () => {
    expect(resolveSince(undefined, "7d", now)).toBe(now - 7 * 86_400_000);
  });

  it("falls back to defaultSince when since is unparsable (fails open, not closed)", () => {
    expect(resolveSince("not a time", "24h", now)).toBe(now - 24 * 3_600_000);
  });
});

describe("formatTimestamp / dayKey", () => {
  const epochMs = new Date("2026-09-14T23:30:00.000Z").valueOf();

  it("formats in UTC when timezone is empty and the host TZ is UTC-equivalent", () => {
    // We don't assert an exact string (depends on the test runner's local TZ);
    // we assert a FIXED timezone renders deterministically instead.
    expect(formatTimestamp(epochMs, "UTC")).toBe("2026-09-14 23:30:00");
  });

  it("shifts the calendar day when a timezone crosses midnight", () => {
    expect(dayKey(epochMs, "UTC")).toBe("2026-09-14");
    expect(dayKey(epochMs, "America/Los_Angeles")).toBe("2026-09-14");
    expect(dayKey(epochMs, "Asia/Tokyo")).toBe("2026-09-15");
  });
});
