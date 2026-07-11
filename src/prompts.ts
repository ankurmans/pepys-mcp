import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** A one-shot "transcribe this and summarize it" prompt for host UIs that surface prompts. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "transcribe_and_summarize",
    {
      title: "Transcribe & summarize",
      description: "Transcribe a recording with Pepys and produce a structured summary.",
      argsSchema: {
        source: z.string().describe("A public URL or a file_ref from upload_file."),
        focus: z.string().optional().describe("What to emphasize in the summary."),
        language: z.string().optional().describe("BCP-47 language hint."),
        diarize: z.string().optional().describe('"true" to label speakers (paid).'),
      },
    },
    ({ source, focus, language, diarize }) => {
      const wantDiarize = diarize === "true";
      const text =
        `Transcribe the recording at ${source} using Pepys, then summarize it. Steps: ` +
        `(1) call transcribe with this source${wantDiarize ? " and diarize:true" : ""}${language ? ` and language:"${language}"` : ""}. ` +
        `(2) Poll get_transcription with wait_ms:25000 until status is "done". ` +
        `(3) Produce: a 3–5 sentence overview; key points as bullets; if speakers are labeled, a one-line takeaway per speaker; any decisions or action items with their timestamps ([hh:mm:ss])` +
        `${focus ? `; focus especially on ${focus}` : ""}. ` +
        `(4) Report billed_minutes at the end. If a tool returns an out-of-credits or upgrade message, relay it to me and stop.`;
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    },
  );
}
