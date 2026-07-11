import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const BILLING_URL = "https://pepys.co/billing";
const KEYS_URL = "https://pepys.co/developers";

/** A non-2xx response from the Pepys API. Carries the parsed body + Retry-After for error mapping. */
export class PepysApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly retryAfter?: number,
  ) {
    super(`Pepys API ${status}`);
    this.name = "PepysApiError";
  }
}

async function parse(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json().catch(() => ({}));
  return res.text();
}

type Query = Record<string, string | number | boolean | undefined>;

/**
 * The transport-agnostic I/O the 9 tools call. Two implementations share ONE fetch core
 * (`makeApiIo`), differing only in credential:
 *  - stdio server → a fixed `pk_live_` key from the env (`makeEnvIo`).
 *  - remote OAuth server → the caller's short-lived OAuth access token (the Next app builds it
 *    with `makeApiIo({ base: <origin>/api/v1, token: session.accessToken })`).
 * Both hit the SAME `/api/v1/*` routes, so every gate (rate-limit, 402 balance, 403 paid-feature,
 * idempotency, 404 IDOR scoping) and the credit debit are reused verbatim – no per-transport code.
 */
export interface Io {
  apiJson<T = unknown>(
    path: string,
    init?: { method?: string; body?: unknown; query?: Query; headers?: Record<string, string> },
  ): Promise<T>;
  apiText(path: string, query?: Query): Promise<string>;
  getTranscriptionCached(id: string): Promise<Transcription>;
}

/**
 * Build an Io that talks to a Pepys v1 REST base with a fixed Bearer token. The transcript cache is
 * per-instance (NOT module-global) so a long-lived multi-tenant remote server never leaks one user's
 * transcript into another's request.
 */
export function makeApiIo(opts: { base: string; token: string | (() => string) }): Io {
  const base = opts.base.replace(/\/$/, "");
  const bearer = () => (typeof opts.token === "function" ? opts.token() : opts.token);
  const cache = new Map<string, Transcription>();

  async function apiJson<T = unknown>(
    path: string,
    init: { method?: string; body?: unknown; query?: Query; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${bearer()}`,
        Accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      throw new PepysApiError(res.status, await parse(res), retryAfter);
    }
    return (await parse(res)) as T;
  }

  async function apiText(path: string, query: Query = {}): Promise<string> {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer()}` } });
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      throw new PepysApiError(res.status, await parse(res), retryAfter);
    }
    return res.text();
  }

  async function getTranscriptionCached(id: string): Promise<Transcription> {
    const hit = cache.get(id);
    if (hit) return hit;
    const t = await apiJson<Transcription>(`/transcriptions/${encodeURIComponent(id)}`);
    if (t.status === "done") cache.set(id, t);
    return t;
  }

  return { apiJson, apiText, getTranscriptionCached };
}

/** The stdio server's Io: base from PEPYS_API_BASE, key from PEPYS_API_KEY (missing → a 401 that
 *  maps to the same graceful "set your key" message). */
export function makeEnvIo(): Io {
  const base = (process.env.PEPYS_API_BASE ?? "https://pepys.co/api/v1").replace(/\/$/, "");
  return makeApiIo({
    base,
    token: () => {
      const k = process.env.PEPYS_API_KEY?.trim();
      if (!k) throw new PepysApiError(401, { error: "unauthorized" });
      return k;
    },
  });
}

// ── Result helpers ──

/** A successful tool result: a human-readable text block + machine-readable structuredContent. */
export function ok(structured: Record<string, unknown>, text?: string): CallToolResult {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

/** A plain text tool result (no structured payload). */
export function okText(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/** An error tool result – `isError:true` with a verbatim user-facing message + a structured
 *  discriminator, per the MCP guidance (business failures are results, never thrown). */
function err(text: string, structured: Record<string, unknown>): CallToolResult {
  return { isError: true, content: [{ type: "text", text }], structuredContent: structured };
}

type Feature = "diarization" | "batch" | "word_level";
const FEATURE_LINE: Record<Feature, string> = {
  diarization: `Speaker diarization (who-said-what labels) is a Pepys Pro capability this account hasn't unlocked yet. Any one-time purchase enables it – along with batch podcast feeds and word-level export – at ${BILLING_URL}. Or tell me to re-run without diarize and I'll give you a plain transcript now.`,
  batch: `Batch transcribing a whole podcast feed is a Pepys Pro capability this account hasn't unlocked yet. Any one-time purchase enables it at ${BILLING_URL}. Or point me at a single episode and I'll transcribe just that one now.`,
  word_level: `Word-level timing export is a Pepys Pro capability this account hasn't unlocked yet. Unlock it with any one-time purchase at ${BILLING_URL}. Segment-level SRT, VTT, TXT, Markdown, and JSON exports are free – want one of those instead?`,
};

/**
 * Map any thrown error (a PepysApiError or a network failure) to a graceful `isError` tool result.
 * `opts.feature` names the pro capability the tool attempted, so a 403 gets the right unlock copy;
 * `opts.neededMinutes`/`balanceMinutes` enrich the 402 out-of-credits message when known.
 */
export function toToolError(
  e: unknown,
  opts: { feature?: Feature; neededMinutes?: number; balanceMinutes?: number } = {},
): CallToolResult {
  if (e instanceof PepysApiError) {
    const body = (e.body ?? {}) as { error?: string; upgrade?: boolean };
    switch (e.status) {
      case 401:
        return err(
          `Your Pepys API key is missing or invalid. Set PEPYS_API_KEY to a key from ${KEYS_URL} (it starts with pk_live_) and reconnect, then I'll try again.`,
          { error: "unauthorized" },
        );
      case 402: {
        const need = opts.neededMinutes != null ? `about ${opts.neededMinutes} min` : "more";
        const have = opts.balanceMinutes != null ? `${opts.balanceMinutes}` : "0";
        return err(
          `You're out of Pepys transcription credits. This job needs ${need} and the account has ${have} left. Top up at ${BILLING_URL} – it's pay-once and credits never expire – then ask me to retry and I'll resume this job.`,
          { error: "out_of_credits", top_up_url: BILLING_URL, needed_minutes: opts.neededMinutes, balance_minutes: opts.balanceMinutes },
        );
      }
      case 403: {
        const feature = opts.feature;
        return err(
          feature ? FEATURE_LINE[feature] : `This is a Pepys Pro capability this account hasn't unlocked yet. Unlock it with any one-time purchase at ${BILLING_URL}.`,
          { error: "upgrade_required", feature, upgrade: true, upgrade_url: BILLING_URL },
        );
      }
      case 429:
        return err(
          `Pepys is rate-limiting right now. I'll wait about ${e.retryAfter ?? 30}s and retry. For lots of files, transcribe_podcast_feed or a single batch is faster than many parallel calls.`,
          { error: "rate_limited", retry_after_seconds: e.retryAfter ?? 30 },
        );
      case 404:
        return err(`No such transcription on this account (${typeof body.error === "string" ? body.error : "not found"}).`, { error: "not_found" });
      default:
        return err(
          `Pepys returned an error (HTTP ${e.status})${typeof body.error === "string" ? `: ${body.error}` : ""}.`,
          { error: "api_error", status: e.status },
        );
    }
  }
  return err(`Request to Pepys failed: ${(e as Error)?.message ?? String(e)}`, { error: "request_failed" });
}

// ── Transcript shapes (shared by tools + resources + the search cache) ──

export interface Segment {
  start: number;
  end: number;
  speaker: string | null;
  text: string;
}
export interface Transcription {
  id: string;
  status: string;
  language: string | null;
  source: string | null;
  title: string | null;
  billed_minutes: number | null;
  created_at: string;
  error: string | null;
  duration_seconds?: number;
  word_count?: number | null;
  text?: string | null;
  summary?: string | null;
  segments?: Segment[];
}
