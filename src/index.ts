#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { makeEnvIo } from "./client.js";

const server = new McpServer(
  { name: "pepys-mcp", version: "0.1.0" },
  {
    instructions:
      "Pepys transcribes audio and video into accurate, speaker-labeled, timestamped transcripts – " +
      "including hours-long files, diarization, correctly-timed SRT/VTT, and paste-a-link ingestion " +
      "(YouTube, podcasts, Drive/Dropbox). Start a job with " +
      "`transcribe`, then poll `get_transcription` (set wait_ms:25000 for short clips). Never trains on your audio.",
  },
);

// The stdio server authenticates with a fixed pk_live_ key from the env.
const io = makeEnvIo();
registerTools(server, io);
registerResources(server, io);
registerPrompts(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel – all diagnostics go to stderr.
  console.error("pepys-mcp stdio server ready");

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void server.close().finally(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error("pepys-mcp fatal:", err);
  process.exit(1);
});
