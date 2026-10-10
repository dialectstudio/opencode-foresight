/**
 * Local file-backed memory store.
 *
 * Each scope is a JSONL file (`memories.jsonl`) where every line is one
 * memory entry. Retrieval uses BM25 lexical scoring with a light recency
 * boost, falling back to the most recent memories when nothing matches —
 * no external server or embedding API required.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type MemoryKind = "fact" | "transcript";

export interface MemoryEntry {
  id: string;
  content: string;
  kind: MemoryKind;
  tags: string[];
  metadata: Record<string, string>;
  sessionId?: string;
  createdAt: string;
}

export interface ScoredMemory extends MemoryEntry {
  score: number;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "has", "have", "how", "i", "if", "in", "is", "it", "its", "me", "my",
  "of", "on", "or", "our", "s", "so", "t", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "to", "was", "we", "were",
  "what", "when", "where", "which", "who", "why", "will", "with", "you",
  "your",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** BM25 parameters. */
const K1 = 1.2;
const B = 0.75;

export class MemoryStore {
  constructor(readonly filePath: string) {}

  /** Read all entries; returns [] when the file does not exist yet. */
  load(): MemoryEntry[] {
    if (!existsSync(this.filePath)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch {
      return [];
    }
    const entries: MemoryEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as MemoryEntry;
        if (parsed && typeof parsed.content === "string" && parsed.id) {
          entries.push(parsed);
        }
      } catch {
        // Skip corrupt lines rather than failing the whole store.
      }
    }
    return entries;
  }

  private persist(entries: MemoryEntry[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const body = entries.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(this.filePath, body ? `${body}\n` : "", "utf-8");
  }

  /** Append a new entry. */
  add(entry: Omit<MemoryEntry, "id" | "createdAt"> & { id?: string; createdAt?: string }): MemoryEntry {
    const full: MemoryEntry = {
      id: entry.id || randomUUID(),
      createdAt: entry.createdAt || new Date().toISOString(),
      content: entry.content,
      kind: entry.kind,
      tags: entry.tags,
      metadata: entry.metadata,
      sessionId: entry.sessionId,
    };
    const entries = this.load();
    entries.push(full);
    this.persist(entries);
    return full;
  }

  /**
   * Upsert by id — replaces any existing entry with the same id.
   * Used by full-session retain so re-retaining a session replaces,
   * rather than duplicates, its transcript.
   */
  upsert(entry: Omit<MemoryEntry, "createdAt"> & { createdAt?: string }): MemoryEntry {
    const entries = this.load();
    const idx = entries.findIndex((e) => e.id === entry.id);
    const full: MemoryEntry = {
      ...entry,
      createdAt: entry.createdAt || (idx >= 0 ? entries[idx].createdAt : new Date().toISOString()),
    };
    if (idx >= 0) {
      entries[idx] = full;
    } else {
      entries.push(full);
    }
    this.persist(entries);
    return full;
  }

  /**
   * Search memories with BM25 scoring plus a recency boost.
   * Falls back to the most recent entries when no term matches.
   */
  search(query: string, limit: number, now: Date = new Date()): ScoredMemory[] {
    const entries = this.load();
    if (!entries.length || limit <= 0) return [];

    const queryTokens = tokenize(query);
    const docs = entries.map((e) => tokenize(`${e.content} ${e.tags.join(" ")} ${e.tags.join(" ")}`));

    // Inverse document frequency (BM25 variant).
    const df = new Map<string, number>();
    for (const tokens of docs) {
      const seen = new Set(tokens);
      for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }

    const N = docs.length;
    const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / N;
    const idf = (term: string): number => {
      const n = df.get(term) || 0;
      return Math.log(1 + (N - n + 0.5) / (n + 0.5));
    };

    const scored: ScoredMemory[] = [];
    for (let i = 0; i < entries.length; i++) {
      const tokens = docs[i];
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

      let score = 0;
      for (const term of queryTokens) {
        const termTf = tf.get(term);
        if (!termTf) continue;
        const norm = termTf * (K1 + 1);
        const denom = termTf + K1 * (1 - B + (B * tokens.length) / (avgLen || 1));
        score += idf(term) * (norm / denom);
      }

      if (score <= 0) continue;

      // Recency boost: newer memories score up to 1.3x.
      const ageDays = Math.max(0, (now.getTime() - Date.parse(entries[i].createdAt)) / 86_400_000);
      score *= 1 + 0.3 * Math.exp(-ageDays / 7);

      // Tag hits are a strong relevance signal — the agent tags memories
      // deliberately (e.g. "convention", "architecture").
      const querySet = new Set(queryTokens);
      const tagHits = entries[i].tags.filter((t) => querySet.has(t.toLowerCase())).length;
      score += tagHits * 0.5;

      scored.push({ ...entries[i], score });
    }

    scored.sort((a, b) => b.score - a.score);

    // Cold-start / generic-query fallback: surface the most recent memories
    // instead of nothing, mirroring how a first recall on an empty topic
    // should still orient the agent.
    if (!scored.length) {
      const recent = [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return recent.slice(0, limit).map((e) => ({ ...e, score: 0 }));
    }

    return scored.slice(0, limit);
  }

  count(): number {
    return this.load().length;
  }
}
