import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWithinRoot } from "../src/paths.ts";

const dirsToClean: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-kid-tutor-paths-"));
  dirsToClean.push(dir);
  return dir;
}

afterEach(() => {
  while (dirsToClean.length > 0) {
    const dir = dirsToClean.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveWithinRoot", () => {
  it("allows a relative path inside the root, including one that doesn't exist yet", async () => {
    const root = makeTempDir();
    const result = await resolveWithinRoot(root, "notes/todo.txt");
    expect(result.ok).toBe(true);
    // Compare against the CANONICAL root (mkdtempSync's tmp base is itself a
    // symlink on macOS, e.g. /var -> /private/var), matching what
    // resolveWithinRoot is documented to return.
    expect(result.resolved).toBe(join(realpathSync(root), "notes", "todo.txt"));
  });

  it("allows an existing file inside the root", async () => {
    const root = makeTempDir();
    writeFileSync(join(root, "hello.py"), "print('hi')");
    const result = await resolveWithinRoot(root, "hello.py");
    expect(result.ok).toBe(true);
  });

  it("rejects a relative path that escapes the root via ..", async () => {
    const root = makeTempDir();
    const result = await resolveWithinRoot(root, "../escape.txt");
    expect(result.ok).toBe(false);
  });

  it("rejects an absolute path outside the root", async () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    const result = await resolveWithinRoot(root, join(outside, "file.txt"));
    expect(result.ok).toBe(false);
  });

  it("rejects a symlink inside the root that points outside it", async () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    writeFileSync(join(outside, "secret.txt"), "nope");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    const result = await resolveWithinRoot(root, "link.txt");
    expect(result.ok).toBe(false);
  });

  it("rejects an empty path", async () => {
    const root = makeTempDir();
    const result = await resolveWithinRoot(root, "");
    expect(result.ok).toBe(false);
  });

  it("allows a nested subdirectory that already exists", async () => {
    const root = makeTempDir();
    mkdirSync(join(root, "sub", "dir"), { recursive: true });
    const result = await resolveWithinRoot(root, "sub/dir/file.txt");
    expect(result.ok).toBe(true);
  });
});
