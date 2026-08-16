/**
 * fleet-pi — a pi extension that publishes fleet agent-status from pi's
 * lifecycle events, so a pi session shows up on the fleet dashboard (working /
 * idle / done) alongside claude and codex.
 *
 * pi has no shell-hook config like Claude Code or Codex; `fleet install pi`
 * registers this directory as a local pi package (see package.json next to this
 * file). It subscribes to pi's lifecycle events and writes the
 * same status-file schema fleet's shell hooks write (see hooks/lib.sh):
 *
 *   agent_start                    -> { state: "working" }
 *   tool_execution_start           -> { state: "working", tool: "Bash: …" | "Edit: …" }
 *   tool_call (question tool)      -> { state: "question" }
 *   tool_execution_end (question)  -> { state: "working" }
 *   rpiv:ask-user:blocked (active)  -> { state: "question" }
 *   rpiv:ask-user:blocked (cleared) -> { state: "working" }
 *   agent_end                      -> { state: "done" }      (fleet ages done -> idle)
 *   session_shutdown               -> remove the status file (pi exited; no stale state)
 *
 * pi auto-runs its tools, so it has no interactive permission prompt. Question
 * tools can still block on user input; @juicesharp/rpiv-ask-user-question
 * publishes that interval on pi's shared event bus, and compatibility-shimmed
 * AskUserQuestion tools are recognized from their tool_call lifecycle. State goes to
 * $FLEET_PI_STATUS_DIR or ~/.cache/pi-status (must match config.ts's
 * PI_STATUS_DIR). It is a no-op outside tmux, since fleet keys every agent on a
 * tmux pane. Every write is wrapped so a status-file error can never break pi.
 *
 * Zero fleet dependency: this file is loaded by pi, not bundled into fleet's
 * binary, and imports nothing from fleet. The pi API surface it uses is declared
 * locally (see PiExtensionAPI) rather than imported from
 * @mariozechner/pi-coding-agent, so fleet stays zero-dependency and typechecks
 * without pulling pi's types. pi invokes the default export with its real
 * ExtensionAPI, which structurally satisfies the local type.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// --- minimal structural view of the pi ExtensionAPI slice this uses -----------
// pi's real handler signature is (event, ctx) => void | Promise<void>; narrower
// handlers (fewer params, void return) are assignable, so these compile against
// pi's real `on` at load time. See pi's docs/extensions.md for the full surface.
interface PiToolExecutionStartEvent {
  toolName: string;
  args: unknown;
}
interface PiToolEvent {
  toolName: string;
}
interface PiSessionInfoChangedEvent {
  name?: string;
}
interface PiExtensionAPI {
  getSessionName?(): string | undefined;
  on(event: 'session_start' | 'agent_start' | 'agent_end' | 'session_shutdown', handler: () => void): void;
  on(event: 'session_info_changed', handler: (event: PiSessionInfoChangedEvent) => void): void;
  on(event: 'tool_execution_start', handler: (event: PiToolExecutionStartEvent) => void): void;
  on(event: 'tool_call' | 'tool_execution_end', handler: (event: PiToolEvent) => void): void;
  events?: {
    on(event: 'rpiv:ask-user:blocked', handler: (payload: { active: boolean }) => void): void;
  };
}

// --- pure helpers (exported for unit tests) -----------------------------------

// Enrich a pi tool call into a fleet activity label, matching the Claude/Codex
// convention: "Bash: <cmd>", "Edit: <file>". pi's built-in tool names are
// lowercase (bash, edit, write, read, …) with `command` (bash) or `path`
// (edit/write/read) inputs; anything else falls back to the capitalized name.
const QUESTION_TOOL_LABEL = 'Ask User Question';

// Claude Code compatibility shims expose `AskUserQuestion`; the native pi
// package exposes `ask_user_question`. The RPIV package also emits a precise
// blocked event, but this lifecycle fallback covers shims that emit nothing.
export function isPiQuestionTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized === 'askuserquestion' || normalized === 'ask_user_question';
}

export function fleetPiLabel(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const cap = toolName ? toolName.charAt(0).toUpperCase() + toolName.slice(1) : '';
  if (toolName === 'bash') {
    const cmd = str(a.command).replace(/\s+/g, ' ').trim().slice(0, 48);
    return cmd ? `Bash: ${cmd}` : 'Bash';
  }
  if (toolName === 'edit' || toolName === 'write' || toolName === 'read') {
    const base = str(a.path).split('/').pop() ?? '';
    return base ? `${cap}: ${base}` : cap;
  }
  return cap;
}

// Serialize a fleet status record. JSON.stringify escapes quotes/newlines in the
// label so a status file can never be corrupted by tool input. Field names and
// shape mirror parseStatusFile in src/state/hooks.ts exactly.
export function buildPiStatusLine(
  state: string,
  pane: string,
  session: string,
  tool: string,
  ts: number,
  tmuxPid: number,
  name?: string,
): string {
  return JSON.stringify({ state, pane, session, ...(name ? { name } : {}), tool, ts, tmux_pid: tmuxPid }) + '\n';
}

// --- extension entry point ----------------------------------------------------
export default function (pi: PiExtensionAPI): void {
  const paneId = process.env.TMUX_PANE ?? '';
  // fleet keys every agent on a tmux pane; outside tmux there is nothing to
  // publish, so register no handlers (a clean no-op).
  if (!process.env.TMUX || !paneId) return;

  // Honor a caller-set override (tests), else the canonical dir config.ts reads.
  const statusDir = process.env.FLEET_PI_STATUS_DIR || join(homedir(), '.cache', 'pi-status');
  const paneNum = paneId.replace(/^%/, '');
  const statusFile = join(statusDir, `${paneNum}.status`);

  const tmuxQuery = (fmt: string): string => {
    try {
      return execFileSync('tmux', ['display-message', '-p', '-t', paneId, fmt], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  let session = tmuxQuery('#{session_name}');
  let tmuxPid = Number(tmuxQuery('#{pid}')) || 0;
  // Action methods are unavailable while Pi is loading extensions. Read the
  // initial session name from session_start, after the runtime is initialized.
  let name: string | undefined;
  let currentState = 'idle';
  let currentTool = '';
  let publishedTool = '';
  let hasPublished = false;

  const write = (state: string, tool: string): void => {
    currentState = state;
    publishedTool = tool;
    try {
      mkdirSync(statusDir, { recursive: true });
      writeFileSync(
        statusFile,
        buildPiStatusLine(state, paneId, session, tool, Math.floor(Date.now() / 1000), tmuxPid, name),
      );
      hasPublished = true;
    } catch {
      // Never break the user's pi session over a status write.
    }
  };

  pi.on('session_start', () => {
    // tmux env is fully populated by now; backfill anything missing at load.
    if (!session) session = tmuxQuery('#{session_name}');
    if (!tmuxPid) tmuxPid = Number(tmuxQuery('#{pid}')) || 0;
    name = pi.getSessionName?.();

    // On /reload, preserve and republish an existing idle/done/working record
    // immediately so the new name appears without waiting for another turn.
    try {
      const existing = JSON.parse(readFileSync(statusFile, 'utf8')) as Record<string, unknown>;
      if (existing.pane === paneId) {
        const state = typeof existing.state === 'string' ? existing.state : 'idle';
        const tool = typeof existing.tool === 'string' ? existing.tool : '';
        write(state, tool);
      }
    } catch {
      // A new session has no status file yet; preserve that existing behavior.
    }
  });
  pi.on('session_info_changed', (event) => {
    name = event.name;
    // Refresh an existing record immediately while preserving its state. Before
    // the first lifecycle write, simply carry the new name into that write.
    if (hasPublished) write(currentState, publishedTool);
  });
  pi.on('agent_start', () => write('working', currentTool));
  pi.on('tool_execution_start', (event) => {
    currentTool = fleetPiLabel(event.toolName, event.args);
    write('working', currentTool);
  });
  pi.on('tool_call', (event) => {
    // tool_call fires after every extension's tool_execution_start handler, so
    // another status extension cannot overwrite this with its own working write.
    if (isPiQuestionTool(event.toolName)) write('question', QUESTION_TOOL_LABEL);
  });
  pi.on('tool_execution_end', (event) => {
    if (isPiQuestionTool(event.toolName)) write('working', currentTool);
  });
  pi.events?.on('rpiv:ask-user:blocked', (payload) => {
    write(payload.active ? 'question' : 'working', payload.active ? 'Ask User Question' : currentTool);
  });
  pi.on('agent_end', () => {
    currentTool = '';
    write('done', '');
  });
  pi.on('session_shutdown', () => {
    // pi is exiting — drop the status file so the pane doesn't linger as done.
    try {
      rmSync(statusFile, { force: true });
    } catch {
      // ignore
    }
  });
}
