/**
 * `events.ts`'s sidecar audit writer — the write-side half of the
 * `SESSION_QUERY_PERSISTENCE_FAILED` fix (see `events.ts`'s module doc).
 * These facts no longer go through `Session.append()`; this asserts they
 * land, one JSON line per call, in the per-session sidecar file instead —
 * and that a write failure never throws (fire-and-forget from hot paths).
 */
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@deepseek-ai/dsh-session";
import {
  kidTutorEvents,
  kidTutorEventsDir,
  kidTutorSidecarPath,
  UNKNOWN_TURN_STEP,
} from "../src/events.ts";

const dirsToClean: string[] = [];
let previousDshHome: string | undefined;

function makeDshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-kid-tutor-events-"));
  dirsToClean.push(dir);
  return dir;
}

function fakeSession(id: string): Session {
  return { id } as Session;
}

function readLines(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  previousDshHome = process.env.DSH_HOME;
});

afterEach(() => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousDshHome;
  while (dirsToClean.length > 0) {
    const dir = dirsToClean.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("kidTutorEventsDir / kidTutorSidecarPath", () => {
  it("resolves under $DSH_HOME/kid-tutor/events, honoring DSH_HOME at call time", () => {
    const home = makeDshHome();
    process.env.DSH_HOME = home;
    expect(kidTutorEventsDir()).toBe(join(home, "kid-tutor", "events"));
    expect(kidTutorSidecarPath("abc")).toBe(
      join(home, "kid-tutor", "events", "abc.jsonl"),
    );
  });

  it("sanitizes unsafe characters in a session id to a safe filename", () => {
    const home = makeDshHome();
    process.env.DSH_HOME = home;
    expect(kidTutorSidecarPath("../../etc/passwd")).toBe(
      join(home, "kid-tutor", "events", ".._.._etc_passwd.jsonl"),
    );
  });
});

describe("kidTutorEvents", () => {
  it("appends one JSON line per call, never touching Session.append", () => {
    const home = makeDshHome();
    process.env.DSH_HOME = home;
    const session = fakeSession("session-1");

    kidTutorEvents.guardVerdict(session, {
      stage: "deterministic",
      verdict: "pass",
      turn: 1,
      step: 1,
    });
    kidTutorEvents.guardVerdict(session, {
      stage: "judge",
      verdict: "block",
      reason: "reveals final answer",
      suppressedText: "The answer is x = 4.",
      category: "personal_info",
      severity: 2,
      turn: 1,
      step: 2,
    });

    const lines = readLines(kidTutorSidecarPath("session-1"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      type: "kid-tutor/guard-verdict",
      data: { stage: "deterministic", verdict: "pass" },
    });
    expect(lines[1]).toMatchObject({
      type: "kid-tutor/guard-verdict",
      data: { verdict: "block", category: "personal_info", severity: 2 },
    });
    expect(typeof (lines[0] as { time: number }).time).toBe("number");
  });

  it("writes each event type to the same session file, correctly shaped", () => {
    const home = makeDshHome();
    process.env.DSH_HOME = home;
    const session = fakeSession("session-2");

    kidTutorEvents.toolDenied(session, {
      tool: "web_fetch",
      reason: 'domain "example.com" is not on the allowlist',
      url: "https://example.com",
      ...UNKNOWN_TURN_STEP,
    });
    kidTutorEvents.quota(session, {
      kind: "turn",
      used: 60,
      limit: 60,
      turn: 5,
    });
    kidTutorEvents.pythonRun(session, {
      file: "main.py",
      exitCode: 1,
      durationMs: 340,
      truncated: false,
      ...UNKNOWN_TURN_STEP,
    });
    kidTutorEvents.alert(session, {
      category: "personal_info",
      severity: 2,
      excerpt: "just give me the answer",
      delivered: true,
      ...UNKNOWN_TURN_STEP,
    });

    const lines = readLines(kidTutorSidecarPath("session-2")) as Array<{
      type: string;
    }>;
    expect(lines.map((l) => l.type)).toEqual([
      "kid-tutor/tool-denied",
      "kid-tutor/quota",
      "kid-tutor/python-run",
      "kid-tutor/alert",
    ]);
  });

  it("keeps separate sessions in separate files", () => {
    const home = makeDshHome();
    process.env.DSH_HOME = home;

    kidTutorEvents.quota(fakeSession("session-a"), {
      kind: "turn",
      used: 1,
      limit: 60,
      turn: 1,
    });
    kidTutorEvents.quota(fakeSession("session-b"), {
      kind: "turn",
      used: 2,
      limit: 60,
      turn: 1,
    });

    expect(readLines(kidTutorSidecarPath("session-a"))).toHaveLength(1);
    expect(readLines(kidTutorSidecarPath("session-b"))).toHaveLength(1);
  });

  it("never throws when the sidecar write fails (fail-open, fire-and-forget contract)", () => {
    // Point DSH_HOME at a path that is a FILE, not a directory, so
    // `mkdirSync(dirname(path), { recursive: true })` fails with ENOTDIR —
    // simulating a real-world "can't create the audit directory" failure
    // without mocking fs internals.
    const dir = makeDshHome();
    const notADirectory = join(dir, "not-a-directory");
    writeFileSync(notADirectory, "x");
    process.env.DSH_HOME = notADirectory;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      kidTutorEvents.quota(fakeSession("session-x"), {
        kind: "cutoff",
        used: 60,
        limit: 60,
        turn: 9,
      }),
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("kid-tutor/quota");
    errorSpy.mockRestore();
  });
});
