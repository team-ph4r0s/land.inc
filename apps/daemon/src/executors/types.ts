import type { Executor as ExecutorId, ModelOption, Task } from '@land/protocol';

/** What to start: the CLI itself, or e.g. `node fake-cli.mjs` in tests. */
export interface Command {
  command: string;
  /** Put before the executor's own arguments. */
  args: string[];
}

export interface ExecutorStatus {
  available: boolean;
  models: ModelOption[];
  /** Why it is unavailable, or what to do about it. */
  note?: string;
}

/** How a finished run went, judged from its exit code and output. */
export interface RunResult {
  ok: boolean;
  text?: string;
  /** The CLI lost its sign-in: the board drops its cached status. */
  signedOut?: boolean;
}

/** Reads one run's output as it streams in. */
export interface OutputParser {
  onStdout(chunk: string): void;
  /** The latest agent message so far, kept for a cancelled run. */
  last(): string | undefined;
  finish(code: number | null, stdout: string, stderr: string): RunResult;
}

export interface PreparedRun {
  args: string[];
  /** Serialized input when the CLI expects a protocol rather than plain text. */
  stdin?: string;
  /** Known before the start when the CLI accepts a session id (Claude). */
  agentId?: string;
  output: OutputParser;
}

/**
 * One coding agent the board can hand tasks to. It knows where its CLI lives, which
 * models it offers, how to turn a task into a command line, and how to read the result.
 * Everything that reaches the command line comes from a validated task.
 */
export interface Executor {
  readonly id: ExecutorId;
  status(catalogModels?: ModelOption[]): ExecutorStatus;
  command(): Command | undefined;
  /** Forget CLI discovery after the user installs or updates an agent. */
  refresh?(): void;
  /**
   * `onAgent` reports an agent id learned from the output (Codex prints its thread id).
   * With `resume`, the run continues that agent session instead of starting a new one.
   */
  prepare(task: Task, onAgent: (agentId: string) => void, resume?: string, captureLimit?: number): PreparedRun;
  /** The CLI's own session id for an office agent id, if this executor can resume it. */
  sessionOf?(agentId: string): string | undefined;
  /** Folders this agent worked in recently, with the time of last use. */
  projects?(): [string, number][];
}
