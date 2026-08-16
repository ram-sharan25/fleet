import { readdirSync, readFileSync, existsSync, watch, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { HookStatus, ResolvedHookStatus } from './types.ts';
import type { AgentDir } from '../agents/config.ts';
import { stripAnsi, truncateWidth } from '../terminal/ansi.ts';

const MAX_HOOK_NAME_WIDTH = 32;
// oxlint-disable-next-line no-control-regex
const CONTROL_PATTERN = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');

export function sanitizeHookName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Treat names as untrusted terminal text: remove escape/control sequences,
  // normalize manual whitespace, and cap the compact dashboard label width.
  const clean = stripAnsi(value).replace(CONTROL_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  const truncated = truncateWidth(clean, MAX_HOOK_NAME_WIDTH).trim();
  return truncated || undefined;
}

// The `.status` / `.events.jsonl` filename convention, named once. Keyed by the
// pane number (`%12` -> `12`), matching what hooks/lib.sh writes.
export function paneNum(paneId: string): string {
  return paneId.replace('%', '');
}

export function statusFilePath(dir: string, paneId: string): string {
  return join(dir, `${paneNum(paneId)}.status`);
}

export function eventsFilePath(dir: string, paneId: string): string {
  return join(dir, `${paneNum(paneId)}.events.jsonl`);
}

// Write-then-rename so a concurrent reader never sees a truncated file —
// rename is atomic within a filesystem.
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function parseStatusFile(content: string): HookStatus | null {
  try {
    const data = JSON.parse(content) as Record<string, unknown>;
    const name = sanitizeHookName(data.name);
    return {
      state: String(data.state ?? 'idle'),
      pane: String(data.pane ?? ''),
      session: String(data.session ?? ''),
      ...(name ? { name } : {}),
      tool: String(data.tool ?? ''),
      ts: Number(data.ts ?? 0),
      tmux_pid: Number(data.tmux_pid ?? 0),
    };
  } catch {
    return null;
  }
}

// Each record is stamped with its owning `agent` and source `statusDir` so the
// caller (index.ts) knows which agent authored the status and which dir to read
// the matching .events.jsonl from — the name travels with the data.
export function readStatusDir(dir: string, agent: string): ResolvedHookStatus[] {
  if (!existsSync(dir)) return [];
  const statuses: ResolvedHookStatus[] = [];
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith('.status')) continue;
      try {
        const content = readFileSync(join(dir, file), 'utf-8');
        const status = parseStatusFile(content);
        if (status) statuses.push({ ...status, agent, statusDir: dir });
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Dir listing failed
  }
  return statuses;
}

export function readAllStatusDirs(dirs: AgentDir[]): ResolvedHookStatus[] {
  const all: ResolvedHookStatus[] = [];
  for (const d of dirs) {
    all.push(...readStatusDir(d.statusDir, d.name));
  }
  return all;
}

export type StatusChangeCallback = () => void;

export function watchStatusDirs(dirs: string[], onChange: StatusChangeCallback): () => void {
  const watchers: ReturnType<typeof watch>[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename && (filename.endsWith('.status') || filename.endsWith('.jsonl'))) {
          onChange();
        }
      });
      watchers.push(watcher);
    } catch {
      // Skip unwatchable dirs
    }
  }
  return () => {
    for (const w of watchers) w.close();
  };
}
