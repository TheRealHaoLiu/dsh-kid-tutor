/**
 * Symlink-safe path confinement, shared by `workspace-fence` (fs tool guard)
 * and `run-python` (the `file` argument). Built on the same deepest-existing-
 * ancestor canonicalization the harness itself uses for watch paths
 * (`@deepseek-ai/dsh-home-paths#canonicalizeWatchPath`), which handles a
 * target that does not exist yet (a file about to be created by `write`).
 *
 * @module dsh-kid-tutor/paths
 */

import { isAbsolute, resolve as resolvePath, sep } from "node:path";
import { canonicalizeWatchPath } from "@deepseek-ai/dsh-home-paths";

export interface ContainmentResult {
  readonly ok: boolean;
  /** Canonical absolute path, present whenever `ok` is true. */
  readonly resolved?: string;
  /** Human-readable reason, present whenever `ok` is false. */
  readonly reason?: string;
}

/**
 * Resolve `inputPath` (absolute, or relative to `root`) to its canonical
 * absolute form and check it falls under `root` (which must itself resolve
 * canonically — a symlinked workspace root is still the root). Fails closed:
 * any unexpected error while canonicalizing is reported as containment
 * failure rather than allowed through.
 *
 * @param root - the confining directory; canonicalized before comparison.
 * @param inputPath - a model-supplied path, however untrusted.
 */
export async function resolveWithinRoot(
  root: string,
  inputPath: string,
): Promise<ContainmentResult> {
  if (inputPath.trim().length === 0) {
    return { ok: false, reason: "path must be a non-empty string" };
  }
  const candidate = isAbsolute(inputPath)
    ? inputPath
    : resolvePath(root, inputPath);
  let canonicalRoot: string;
  let canonicalCandidate: string;
  try {
    canonicalRoot = await canonicalizeWatchPath(root);
  } catch (error) {
    return {
      ok: false,
      reason: `workspace root is not accessible: ${(error as Error).message}`,
    };
  }
  try {
    canonicalCandidate = await canonicalizeWatchPath(candidate);
  } catch (error) {
    return { ok: false, reason: `path is not accessible: ${(error as Error).message}` };
  }
  const withinRoot =
    canonicalCandidate === canonicalRoot ||
    canonicalCandidate.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep);
  if (!withinRoot) {
    return { ok: false, reason: "path resolves outside the workspace" };
  }
  return { ok: true, resolved: canonicalCandidate };
}
