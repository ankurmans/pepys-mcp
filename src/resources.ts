import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Io } from "./client.js";

function hhmmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

interface JobRow {
  id: string;
  status: string;
  title: string | null;
  source: string | null;
  billed_minutes: number | null;
}

/** Expose finished transcripts as `pepys://transcription/{id}` so hosts can attach them.
 *  Keep get_transcription as the guaranteed retrieval path (some hosts list but never read). */
export function registerResources(server: McpServer, io: Io): void {
  server.registerResource(
    "transcription",
    new ResourceTemplate("pepys://transcription/{id}", {
      list: async () => {
        try {
          const { data } = await io.apiJson<{ data: JobRow[] }>("/transcriptions");
          return {
            resources: data
              .filter((r) => r.status === "done")
              .map((r) => ({
                uri: `pepys://transcription/${r.id}`,
                name: r.title ?? r.source ?? r.id,
                description: `${r.billed_minutes ?? 0} min transcript`,
                mimeType: "text/markdown",
              })),
          };
        } catch {
          return { resources: [] };
        }
      },
      complete: {
        id: async (value: string) => {
          try {
            const { data } = await io.apiJson<{ data: JobRow[] }>("/transcriptions");
            return data.filter((r) => r.status === "done" && r.id.startsWith(value)).map((r) => r.id).slice(0, 20);
          } catch {
            return [];
          }
        },
      },
    }),
    { title: "Pepys transcription", description: "A finished Pepys transcription, by id", mimeType: "text/markdown" },
    async (uri, variables) => {
      const id = String(variables.id);
      const t = await io.getTranscriptionCached(id);
      if (t.status !== "done") {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: `Transcription ${id} is ${t.status}.` }] };
      }
      const md = (t.segments ?? [])
        .map((s) => `[${hhmmss(s.start)}] ${s.speaker ? `${s.speaker}: ` : ""}${s.text}`)
        .join("\n");
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: `# ${t.title ?? "Transcript"}\n\n_${t.duration_seconds ?? "?"}s · ${t.language ?? "?"}_\n\n${t.summary ? `**Summary:** ${t.summary}\n\n` : ""}${md}`,
          },
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              { id: t.id, language: t.language, duration_seconds: t.duration_seconds, billed_minutes: t.billed_minutes, summary: t.summary, segments: t.segments },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
