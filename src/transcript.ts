/**
 * The conversation behind a run. A job that starts Claude Code says which session it started by
 * printing one line near the top of its output:
 *
 *   claude-session: <session uuid>          (claude -p --session-id <uuid> …)
 *
 * The page then shows that session next to the run. Only a session a run names is ever read, only
 * from Claude Code's own session folder on this machine, and what leaves this process is the text:
 * what was asked, what was answered, each tool call with a bounded piece of its input and result.
 * Images, thinking and bookkeeping lines are left out.
 */
import { join } from "node:path";

const MARK = /^claude-session:[ \t]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[ \t]*$/im;

/** The session a run's output names, or null. */
export function sessionOf(output: string | undefined | null): string | null {
  return MARK.exec(output ?? "")?.[1]?.toLowerCase() ?? null;
}

export type Entry =
  | { kind: "user" | "assistant"; at?: string; text: string }
  | { kind: "tool"; at?: string; name: string; title: string; input: string; result?: string; failed?: boolean };

export interface Transcript {
  session: string;
  entries: Entry[];
  /** True when the session has more entries than are returned. */
  truncated: boolean;
}

export const LIMITS = { entries: 1500, text: 12_000, input: 3_000, result: 4_000, title: 160 };

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n…(${s.length - max} more chars)` : s);

type Block = { type?: string; text?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

/** The words of a message or of a tool result; an image is named, not sent. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[]).map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : b?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
}

/** One line saying what a tool call was for: its own description, else its main argument. */
function titleOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["description", "command", "file_path", "path", "pattern", "url", "query", "skill", "prompt"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim().split("\n")[0]!.slice(0, LIMITS.title);
  }
  return "";
}

function inputOf(input: unknown): string {
  if (input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string") return (input as { command: string }).command;
  try { return JSON.stringify(input ?? {}, null, 2); } catch { return ""; }
}

/** Folds session lines (JSONL, as Claude Code writes them) into entries; a tool's result joins its call. */
export function entryReader(limits = LIMITS) {
  const entries: Entry[] = [];
  const calls = new Map<string, Extract<Entry, { kind: "tool" }>>();
  let truncated = false;
  const push = (e: Entry) => { if (entries.length < limits.entries) { entries.push(e); return true; } truncated = true; return false; };
  const add = (line: string) => {
    if (!line.trim()) return;
    let o: { type?: string; isSidechain?: boolean; isMeta?: boolean; timestamp?: string; message?: { content?: unknown } };
    try { o = JSON.parse(line); } catch { return; }
    if ((o.type !== "user" && o.type !== "assistant") || o.isSidechain || o.isMeta) return;
    const at = typeof o.timestamp === "string" ? o.timestamp : undefined;
    const content = o.message?.content;
    const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Block[]) : [];
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        push({ kind: o.type, ...(at ? { at } : {}), text: cut(b.text.trim(), limits.text) });
      } else if (b?.type === "tool_use" && o.type === "assistant") {
        const e: Extract<Entry, { kind: "tool" }> = { kind: "tool", ...(at ? { at } : {}), name: String(b.name ?? "tool"), title: titleOf(b.input), input: cut(inputOf(b.input), limits.input) };
        if (push(e) && typeof b.id === "string") calls.set(b.id, e);
      } else if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        const call = calls.get(b.tool_use_id);
        if (!call) continue;
        call.result = cut(textOf(b.content).trim(), limits.result);
        if (b.is_error) call.failed = true;
        calls.delete(b.tool_use_id);
      }
    }
  };
  return { add, done: () => ({ entries, truncated }) };
}

export function readEntries(lines: Iterable<string>, limits = LIMITS): { entries: Entry[]; truncated: boolean } {
  const r = entryReader(limits);
  for (const line of lines) r.add(line);
  return r.done();
}

/** A file's lines, read as a stream: a session with pictures in it can be large. */
async function* linesOf(path: string): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let rest = "";
  const reader = Bun.file(path).stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += dec.decode(value, { stream: true });
    let i: number;
    while ((i = rest.indexOf("\n")) >= 0) { yield rest.slice(0, i); rest = rest.slice(i + 1); }
  }
  rest += dec.decode();
  if (rest) yield rest;
}

/** The session's file under Claude Code's folder (`<dir>/projects/<project>/<session>.jsonl`), or null. */
export async function findSession(claudeDir: string, session: string): Promise<string | null> {
  if (!sessionOf(`claude-session: ${session}`)) return null;
  const root = join(claudeDir, "projects");
  try {
    for await (const hit of new Bun.Glob(`*/${session}.jsonl`).scan({ cwd: root, onlyFiles: true })) return join(root, hit);
  } catch { /* no such folder on this machine */ }
  return null;
}

/** The session as entries, or null when this machine does not have it (Claude Code removes old sessions). */
export async function readTranscript(claudeDir: string, session: string, limits = LIMITS): Promise<Transcript | null> {
  const file = await findSession(claudeDir, session);
  if (!file) return null;
  const r = entryReader(limits);
  for await (const line of linesOf(file)) r.add(line);
  return { session, ...r.done() };
}
