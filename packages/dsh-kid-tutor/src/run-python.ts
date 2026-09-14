/**
 * `run-python` — a custom `run_python` tool. NOT a shell: it spawns
 * `python3` (configurable) directly with an explicit argv array (`spawn`,
 * never `shell: true`), so there is no argv passthrough or shell metachar
 * interpretation at any point.
 *
 * @module dsh-kid-tutor/run-python
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { PythonBinSchema, WorkspaceRootSchema, resolveWorkspaceRoot } from "./config.ts";
import { resolveWithinRoot } from "./paths.ts";
import { kidTutorEvents, UNKNOWN_TURN_STEP } from "./events.ts";

export const name = "dsh-kid-tutor/run-python";
export const inject = ["tools", "systemPrompt"] as const;

export interface Config {
  workspaceRoot?: string;
  pythonBin?: string;
  /** Cooperative kill timeout in milliseconds. */
  timeoutMs?: number;
}

export const Config: z<Config> = z.object({
  workspaceRoot: WorkspaceRootSchema,
  pythonBin: PythonBinSchema,
  timeoutMs: z.number().default(10_000),
});

const OUTPUT_CAP_BYTES = 64 * 1024;
const TRUNCATION_NOTE = "\n[... output truncated at 64 KiB ...]";

/** Env scrubbed to exactly PATH/HOME/LANG — no API keys, no DSH_* variables, nothing else. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (process.env.LANG !== undefined) env.LANG = process.env.LANG;
  return env;
}

/** Append a chunk to a capped buffer; returns whether the cap was newly hit. */
class CappedBuffer {
  private text = "";
  private hit = false;
  push(chunk: Buffer): void {
    if (this.hit) return;
    this.text += chunk.toString("utf8");
    if (Buffer.byteLength(this.text, "utf8") > OUTPUT_CAP_BYTES) {
      // Trim to the byte cap on a UTF-8-safe boundary via Buffer slicing.
      const buf = Buffer.from(this.text, "utf8").subarray(0, OUTPUT_CAP_BYTES);
      this.text = buf.toString("utf8") + TRUNCATION_NOTE;
      this.hit = true;
    }
  }
  get value(): string {
    return this.text;
  }
  get truncated(): boolean {
    return this.hit;
  }
}

interface RunPythonArgs {
  code?: string;
  file?: string;
}

interface RunPythonResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export function apply(ctx: Context, config: Config = {}): void {
  const workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot);
  const pythonBin = config.pythonBin ?? "python3";
  const timeoutMs = config.timeoutMs ?? 10_000;

  ctx.systemPrompt.section({
    name: "tool:run_python",
    order: 101,
    text:
      "Use run_python to run Python code for the student, in their own project folder. " +
      "Pass either `code` (a snippet) or `file` (a path inside the workspace) — never both. " +
      `Runs stop after ${Math.round(timeoutMs / 1000)}s and output is capped; say so plainly if that happens rather than guessing at what the rest would have shown.`,
  });

  ctx.tools.register(
    defineTool({
      name: "run_python",
      description:
        "Run Python 3 code for the student. Provide exactly one of `code` (a snippet, run via stdin) or " +
        "`file` (a path to an existing .py file inside the workspace). Not a general shell: no other " +
        "programs, no shell operators, no network access beyond what the Python code itself opens.",
      parameters: {
        code: { type: "string", description: "Python source to run via stdin." },
        file: { type: "string", description: "Path to a .py file inside the workspace to run." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            exitCode: { type: "integer", required: true },
            stdout: { type: "string", required: true },
            stderr: { type: "string", required: true },
            truncated: { type: "boolean", required: true },
            timedOut: { type: "boolean", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: [
              `exit code: ${value.exitCode}${value.timedOut ? " (timed out)" : ""}`,
              "--- stdout ---",
              value.stdout || "(empty)",
              "--- stderr ---",
              value.stderr || "(empty)",
            ].join("\n"),
          },
        ],
      },
      async execute(args: RunPythonArgs, exec): Promise<RunPythonResult> {
        const hasCode = args.code !== undefined;
        const hasFile = args.file !== undefined;
        if (hasCode === hasFile) {
          throw new Error("run_python: pass exactly one of `code` or `file`, not both or neither");
        }

        let scriptPath: string | undefined;
        if (hasFile) {
          const check = await resolveWithinRoot(workspaceRoot, args.file!);
          if (!check.ok) {
            const session = exec.agent?.session;
            if (session !== undefined) {
              kidTutorEvents.toolDenied(session, {
                tool: "run_python",
                reason: check.reason ?? "path resolves outside the workspace",
                path: args.file,
                ...UNKNOWN_TURN_STEP,
              });
            }
            throw new Error("run_python: file must be inside your own project folder");
          }
          scriptPath = check.resolved;
        }

        const argv = ["-I", ...(scriptPath !== undefined ? [scriptPath] : ["-"])];
        const start = Date.now();
        const result = await new Promise<RunPythonResult>((resolvePromise, rejectPromise) => {
          const child = spawn(pythonBin, argv, {
            cwd: workspaceRoot,
            env: scrubbedEnv(),
            stdio: ["pipe", "pipe", "pipe"],
          });

          const stdout = new CappedBuffer();
          const stderr = new CappedBuffer();
          let timedOut = false;
          let settled = false;

          const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs);

          const onAbort = (): void => {
            child.kill("SIGKILL");
          };
          exec.signal.addEventListener("abort", onAbort, { once: true });

          const cleanup = (): void => {
            clearTimeout(timer);
            exec.signal.removeEventListener("abort", onAbort);
          };

          child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
          child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

          child.on("error", (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectPromise(new Error(`run_python: failed to start ${pythonBin}: ${error.message}`));
          });

          child.on("close", (code, signal) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolvePromise({
              exitCode: code ?? (signal !== null ? -1 : 0),
              stdout: stdout.value,
              stderr: stderr.value,
              truncated: stdout.truncated || stderr.truncated,
              timedOut,
            });
          });

          if (hasCode) {
            child.stdin?.end(args.code, "utf8");
          } else {
            child.stdin?.end();
          }
        });

        const session = exec.agent?.session;
        if (session !== undefined) {
          kidTutorEvents.pythonRun(session, {
            ...(scriptPath !== undefined ? { file: scriptPath } : {}),
            exitCode: result.exitCode,
            durationMs: Date.now() - start,
            truncated: result.truncated,
            ...UNKNOWN_TURN_STEP,
          });
        }

        return result;
      },
    }),
  );
}
