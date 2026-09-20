import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ok,
  toToolError,
  type Io,
  type Segment,
  type Transcription,
} from "./client.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

/** ms/seconds → hh:mm:ss for quotable timestamps. */
function hhmmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav",
  ".flac": "audio/flac", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/opus",
  ".webm": "video/webm", ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
};

const segmentOutput = z.object({
  start: z.number(),
  end: z.number(),
  speaker: z.string().nullable(),
  text: z.string(),
});

const looseRecord = z.record(z.string(), z.unknown());

const evidenceCitationOutput = z.object({
  segmentId: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  excerpt: z.string(),
  speaker: z.string().nullable(),
});

/** Poll a job to a terminal state, up to waitMs (hard-capped at 25s to stay under host timeouts). */
async function pollUntilDone(io: Io, id: string, waitMs: number): Promise<Transcription> {
  const budget = Math.min(Math.max(0, waitMs), 25_000);
  const deadline = Date.now() + budget;
  let t = await io.apiJson<Transcription>(`/transcriptions/${enc(id)}`);
  while (t.status !== "done" && t.status !== "failed" && t.status !== "canceled" && Date.now() < deadline) {
    await sleep(Math.min(3000, Math.max(250, deadline - Date.now())));
    t = await io.apiJson<Transcription>(`/transcriptions/${enc(id)}`);
  }
  return t;
}

export function registerTools(server: McpServer, io: Io): void {
  // ── transcribe ──────────────────────────────────────────────────────────
  server.registerTool(
    "transcribe",
    {
      title: "Transcribe audio/video",
      description:
        "Transcribe audio or video into a speaker-labeled (diarized), timestamped transcript with SRT/VTT caption timing. Accepts a file_ref from upload_file or a url (YouTube, podcast episode, RSS feed, Google Drive/Dropbox share). Audio is never used to train models. Returns { job_id, status }; fetch the result with get_transcription.",
      inputSchema: {
        url: z.url().optional().describe("Public media URL: a file, YouTube video, podcast RSS feed or episode, or a Drive/Dropbox share. Provide EITHER url OR file_ref."),
        file_ref: z.string().optional().describe("A file_ref from upload_file, for local media. Provide EITHER url OR file_ref."),
        language: z.string().optional().describe("BCP-47 hint, e.g. 'en'. Omit to auto-detect."),
        diarize: z.boolean().default(false).describe("Label who said what. Requires an account entitlement; a non-entitled account gets a clear unavailable-feature result."),
        summary: z.boolean().default(false).describe("Also generate an AI summary."),
        chapters: z.boolean().default(false).describe("Also generate chapters."),
        translate_to: z.string().optional().describe("BCP-47 target to translate the transcript into."),
        quality: z
          .enum(["fast", "accurate"])
          .optional()
          .describe("Optional transcription mode. Omit unless the server advertises support."),
        episode_guid: z.string().optional().describe("Pick one podcast-feed episode by guid. Only with a feed url; mutually exclusive with episode_index."),
        episode_index: z.number().int().nonnegative().optional().describe("Pick one podcast-feed episode by position (0 = newest). Mutually exclusive with episode_guid."),
        idempotency_key: z.string().optional().describe("Make retries safe; the same key returns the same job."),
      },
      outputSchema: {
        job_id: z.string(),
        status: z.string(),
        cached: z.boolean(),
      },
      annotations: { title: "Transcribe audio/video", readOnlyHint: false, openWorldHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (a) => {
      if (!!a.url === !!a.file_ref) return toolInputError("Provide exactly one of url or file_ref.");
      if (a.episode_guid && a.episode_index != null) return toolInputError("Provide at most one of episode_guid or episode_index.");
      if ((a.episode_guid || a.episode_index != null) && !a.url) return toolInputError("episode_guid/episode_index only apply when url is a podcast feed.");
      try {
        const res = await io.apiJson<{ id: string; status: string; cached?: boolean }>("/transcriptions", {
          method: "POST",
          body: {
            url: a.url,
            media_ref: a.file_ref,
            language: a.language,
            diarize: a.diarize || undefined,
            summary: a.summary || undefined,
            chapters: a.chapters || undefined,
            translate_to: a.translate_to,
            quality: a.quality,
            episode_guid: a.episode_guid,
            episode_index: a.episode_index,
          },
          headers: a.idempotency_key ? { "Idempotency-Key": a.idempotency_key } : undefined,
        });
        return ok(
          { job_id: res.id, status: res.status, cached: res.cached ?? false },
          `Started transcription. job_id=${res.id}, status=${res.status}. ${res.status === "done" ? "Already done (cache hit) – call get_transcription." : "Call get_transcription with wait_ms:25000 to fetch it."}`,
        );
      } catch (e) {
        return toToolError(e, { feature: a.diarize ? "diarization" : undefined });
      }
    },
  );

  // ── get_transcription ───────────────────────────────────────────────────
  server.registerTool(
    "get_transcription",
    {
      title: "Get transcription result",
      description:
        "Fetch a transcription by job_id: full text, per-speaker timestamped segments, summary, duration_seconds, billed_minutes, and language. Set wait_ms (up to 25000) to long-poll so short clips come back in one call; otherwise poll until status is 'done'.",
      inputSchema: {
        job_id: z.string().min(1),
        wait_ms: z.number().int().min(0).max(25_000).default(0).describe("Long-poll up to this many ms (cap 25000) for the job to finish."),
      },
      outputSchema: {
        id: z.string().optional(),
        job_id: z.string().optional(),
        status: z.string(),
        title: z.string().nullable().optional(),
        source: z.string().nullable().optional(),
        language: z.string().nullable().optional(),
        billed_minutes: z.number().nullable().optional(),
        duration_seconds: z.number().optional(),
        text: z.string().nullable().optional(),
        summary: z.string().nullable().optional(),
        segments: z.array(segmentOutput).optional(),
      },
      annotations: { title: "Get transcription result", readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ job_id, wait_ms }) => {
      try {
        const t = wait_ms > 0 ? await pollUntilDone(io, job_id, wait_ms) : await io.apiJson<Transcription>(`/transcriptions/${enc(job_id)}`);
        if (t.status === "failed" || t.status === "canceled") {
          return { isError: true, content: [{ type: "text", text: `That transcription ${t.status}: ${t.error ?? "unknown error"}. If it was a link, check it's public and points at real audio/video; then ask me to retry.` }], structuredContent: { status: t.status, error: t.error } };
        }
        if (t.status !== "done") {
          return ok({ job_id, status: t.status }, `Still ${t.status}. Call get_transcription again with wait_ms:25000, or set up a webhook.`);
        }
        const header = `Transcript ${t.title ? `"${t.title}" ` : ""}(${t.duration_seconds ?? "?"}s, ${t.language ?? "?"}, billed ${t.billed_minutes ?? 0} min):\n\n`;
        return ok(t as unknown as Record<string, unknown>, header + (t.text ?? ""));
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  // ── upload_file ─────────────────────────────────────────────────────────
  server.registerTool(
    "upload_file",
    {
      title: "Upload local media",
      description:
        "Upload local audio/video the agent is holding (as base64 bytes or a file path) and get back a file_ref to pass to transcribe. Use this when the media has no public URL. Requires the Pepys R2 storage backend.",
      inputSchema: {
        path: z.string().optional().describe("Absolute path to a local audio/video file. Provide EITHER path OR bytes_base64."),
        bytes_base64: z.string().optional().describe("Base64-encoded media bytes. Provide EITHER path OR bytes_base64."),
        filename: z.string().optional().describe("Original filename (used to infer content type when mime_type is omitted)."),
        mime_type: z.string().optional().describe("audio/* or video/* content type. Inferred from the filename/path extension if omitted."),
      },
      outputSchema: { file_ref: z.string() },
      annotations: { title: "Upload local media", readOnlyHint: false, openWorldHint: false, idempotentHint: false, destructiveHint: false },
    },
    async (a) => {
      if (!!a.path === !!a.bytes_base64) return toolInputError("Provide exactly one of path or bytes_base64.");
      try {
        let buf: Buffer;
        let name = a.filename;
        if (a.path) {
          buf = await readFile(a.path);
          name = name ?? basename(a.path);
        } else {
          buf = Buffer.from(a.bytes_base64!, "base64");
        }
        const ext = name ? extname(name).toLowerCase() : "";
        const contentType = a.mime_type ?? MIME[ext];
        if (!contentType || !/^(audio|video)\//.test(contentType)) {
          return toolInputError("Could not determine an audio/* or video/* content type. Pass mime_type explicitly.");
        }
        const handshake = await io.apiJson<{ upload_url: string; media_ref: string; expires_in: number }>("/uploads", {
          method: "POST",
          body: { filename: name, content_type: contentType, bytes: buf.length },
        });
        const put = await fetch(handshake.upload_url, {
          method: "PUT",
          headers: { "content-type": contentType, "content-length": String(buf.length) },
          body: buf,
        });
        if (!put.ok) {
          return { isError: true, content: [{ type: "text", text: `Upload failed at the storage step (HTTP ${put.status}).` }], structuredContent: { error: "upload_put_failed", status: put.status } };
        }
        return ok({ file_ref: handshake.media_ref }, `Uploaded. Pass file_ref="${handshake.media_ref}" to transcribe.`);
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  // ── list_transcriptions ─────────────────────────────────────────────────
  server.registerTool(
    "list_transcriptions",
    {
      title: "List recent transcriptions",
      description:
        "List this account's recent transcription jobs with their job_id, status, title, and duration, so you can resume, fetch, or export an earlier result instead of re-transcribing.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        status: z.enum(["queued", "processing", "done", "failed", "canceled"]).optional(),
      },
      outputSchema: {
        transcriptions: z.array(looseRecord),
        count: z.number().int().nonnegative(),
      },
      annotations: { title: "List recent transcriptions", readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ limit, status }) => {
      try {
        const { data } = await io.apiJson<{ data: Array<Record<string, unknown>> }>("/transcriptions");
        let rows = data;
        if (status) rows = rows.filter((r) => r.status === status);
        rows = rows.slice(0, limit);
        const text = rows.length
          ? rows.map((r) => `${r.id}  ${r.status}  ${r.title ?? r.source ?? "untitled"}  (${r.billed_minutes ?? 0} min)`).join("\n")
          : "No transcriptions yet.";
        return ok({ transcriptions: rows, count: rows.length }, text);
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  // ── list_podcast_episodes ───────────────────────────────────────────────
  server.registerTool(
    "list_podcast_episodes",
    {
      title: "List podcast episodes",
      description:
        "Given a podcast RSS feed or Apple Podcasts show URL, list its episodes (title, publish date, episode_guid, audio_url) so you can pick exactly which one to transcribe.",
      inputSchema: {
        feed_url: z.url(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      outputSchema: {
        total: z.number().int().nonnegative(),
        returned: z.number().int().nonnegative(),
        data: z.array(looseRecord),
      },
      annotations: { title: "List podcast episodes", readOnlyHint: true, openWorldHint: true, idempotentHint: true, destructiveHint: false },
    },
    async ({ feed_url, limit }) => {
      try {
        const res = await io.apiJson<{ total: number; returned: number; data: Array<Record<string, unknown>> }>(
          "/podcasts/episodes",
          { query: { feed: feed_url, limit } },
        );
        const text = res.data.map((e, i) => `[${i}] ${e.title} – ${e.published_at ?? "?"} (${e.duration_seconds ?? "?"}s)  guid=${e.guid ?? "?"}`).join("\n");
        return ok(res, `${res.returned}/${res.total} episodes:\n${text}`);
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  // ── transcribe_podcast_feed ─────────────────────────────────────────────
  server.registerTool(
    "transcribe_podcast_feed",
    {
      title: "Batch-transcribe a podcast feed",
      description:
        "Batch-transcribe a whole podcast feed in one call – fan out every episode, or the latest N, to individual jobs. Returns a set of job_ids. Requires an account entitlement.",
      inputSchema: {
        feed_url: z.url(),
        latest: z.number().int().min(1).optional().describe("Transcribe only the newest N episodes; omit for the whole feed."),
        diarize: z.boolean().default(false),
        idempotency_key: z.string().optional().describe("Make retries safe; the same key returns the same batch (no re-billing)."),
      },
      outputSchema: {
        batch_id: z.string(),
        total: z.number().int().nonnegative(),
        transcriptions: z.array(looseRecord),
        skipped: z.array(z.unknown()).optional(),
        idempotent_replay: z.boolean().optional(),
      },
      annotations: { title: "Batch-transcribe a podcast feed", readOnlyHint: false, openWorldHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (a) => {
      try {
        const res = await io.apiJson<{ batch_id: string; total: number; transcriptions: Array<Record<string, unknown>>; skipped?: unknown[]; idempotent_replay?: boolean }>(
          "/podcasts/transcribe",
          {
            method: "POST",
            body: { feed: a.feed_url, episodes: a.latest ?? "all", diarize: a.diarize || undefined },
            headers: a.idempotency_key ? { "Idempotency-Key": a.idempotency_key } : undefined,
          },
        );
        return ok(res, `Queued ${res.total} episodes (batch ${res.batch_id}). Poll each job_id with get_transcription.`);
      } catch (e) {
        return toToolError(e, { feature: "batch" });
      }
    },
  );

  // ── export_transcript ───────────────────────────────────────────────────
  server.registerTool(
    "export_transcript",
    {
      title: "Export a transcript",
      description:
        "Export a finished transcript as SRT, VTT, TXT, Markdown, or JSON, with caption timings. Word-level timing (word_level:true) requires an account entitlement; segment-level export remains available without it. (DOCX/PDF are available in the Pepys web app.)",
      inputSchema: {
        job_id: z.string().min(1),
        format: z.enum(["srt", "vtt", "txt", "md", "json"]),
        word_level: z.boolean().default(false).describe("Include word-level timings when the account has that entitlement. Otherwise use segment-level timing."),
      },
      outputSchema: {
        format: z.enum(["srt", "vtt", "txt", "md", "json"]),
        word_level: z.boolean(),
        transcript: z.string(),
      },
      annotations: { title: "Export a transcript", readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ job_id, format, word_level }) => {
      try {
        const body = await io.apiText(`/transcriptions/${enc(job_id)}/export`, { format, word_level: word_level || undefined });
        return ok({ format, word_level, transcript: body }, body);
      } catch (e) {
        return toToolError(e, { feature: word_level ? "word_level" : undefined });
      }
    },
  );

  // ── search_transcript (client-side over cached segments) ─────────────────
  server.registerTool(
    "search_transcript",
    {
      title: "Search within a transcript",
      description:
        "Search inside a long transcript for a phrase and get back only the matching timestamped segments – locate a quote or topic in an hours-long recording without loading the whole transcript into context.",
      inputSchema: {
        job_id: z.string().min(1),
        query: z.string().min(1),
        case_sensitive: z.boolean().default(false),
        whole_word: z.boolean().default(false),
        context_segments: z.number().int().min(0).max(3).default(0).describe("Also return this many neighbor segments around each hit."),
        max_results: z.number().int().min(1).max(100).default(20),
      },
      outputSchema: {
        total_matches: z.number().int().nonnegative(),
        returned: z.number().int().nonnegative(),
        matches: z.array(segmentOutput),
      },
      annotations: { title: "Search within a transcript", readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ job_id, query, case_sensitive, whole_word, context_segments, max_results }) => {
      try {
        const t = await io.getTranscriptionCached(job_id);
        if (t.status !== "done") return toolInputError(`That job is ${t.status}, not done – poll get_transcription first, then search.`);
        const segs: Segment[] = t.segments ?? [];
        const q = case_sensitive ? query : query.toLowerCase();
        const wordRe = whole_word ? new RegExp(`\\b${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, case_sensitive ? "" : "i") : null;
        const hitIdx: number[] = [];
        segs.forEach((s, i) => {
          const hay = case_sensitive ? s.text : s.text.toLowerCase();
          if (wordRe ? wordRe.test(s.text) : hay.includes(q)) hitIdx.push(i);
        });
        const chosen = hitIdx.slice(0, max_results);
        const withCtx = new Set<number>();
        for (const i of chosen) for (let j = i - context_segments; j <= i + context_segments; j++) if (j >= 0 && j < segs.length) withCtx.add(j);
        const matches = [...withCtx].sort((x, y) => x - y).map((i) => segs[i]);
        const text = matches.length
          ? matches.map((s) => `[${hhmmss(s.start)}] ${s.speaker ? `${s.speaker}: ` : ""}${s.text}`).join("\n")
          : `No matches for "${query}".`;
        return ok({ total_matches: hitIdx.length, returned: matches.length, matches }, text);
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  // ── ask_transcription (server-verified evidence) ────────────────────────
  server.registerTool(
    "ask_transcription",
    {
      title: "Ask a transcription with verified evidence",
      description:
        "Answer a question using a finished transcript. Returns only independently supported claims with canonical source segment IDs, exact timestamps, excerpts, coverage and withheld-claim counts. Unsupported or invented citations are not presented as answers.",
      inputSchema: {
        job_id: z.string().min(1),
        question: z.string().min(1).max(4_000),
      },
      outputSchema: {
        contractVersion: z.literal(1),
        status: z.enum(["supported", "partial", "not_found"]),
        text: z.string(),
        claims: z.array(
          z.object({
            id: z.string(),
            text: z.string(),
            citations: z.array(evidenceCitationOutput),
          }),
        ),
        withheld: z.array(
          z.object({
            claimId: z.string(),
            reason: z.enum(["invalid_citation", "unsupported", "irrelevant", "uncertain"]),
          }),
        ),
        coverage: z.object({
          sourceSegments: z.number().int().nonnegative(),
          includedSegments: z.number().int().nonnegative(),
          truncated: z.boolean(),
        }),
      },
      annotations: { title: "Ask a transcription with verified evidence", readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ job_id, question }) => {
      try {
        const answer = await io.apiJson<Record<string, unknown>>(
          `/transcriptions/${enc(job_id)}/ask`,
          { method: "POST", body: { question } },
        );
        return ok(answer, String(answer.text ?? "No supported answer found."));
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  // ── get_credit_balance ──────────────────────────────────────────────────
  server.registerTool(
    "get_credit_balance",
    {
      title: "Check credit balance",
      description:
        "Return the account's remaining transcription credits (in minutes) so you can check headroom before starting a large batch and avoid running out mid-run.",
      inputSchema: {},
      outputSchema: {
        balance: z.number(),
        minutes: z.number(),
        is_paid: z.boolean(),
      },
      annotations: { title: "Check credit balance", readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const c = await io.apiJson<{ balance: number; minutes: number; is_paid: boolean }>("/credits");
        return ok(c, `${c.minutes} minutes of transcription balance remaining.`);
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}

/** A caller-input validation failure (not an API error) → isError result the model can act on. */
function toolInputError(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }], structuredContent: { error: "invalid_input", message } };
}
