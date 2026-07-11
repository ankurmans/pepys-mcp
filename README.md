# pepys-mcp

The **Pepys transcription MCP server** – give any MCP-speaking agent (Claude, ChatGPT, Cursor, Gemini, open-source agents) accurate, speaker-labeled, timestamped transcription of hours-long audio and video: diarization, correctly-timed SRT/VTT captions, paste-a-link ingestion (YouTube, podcasts, Drive/Dropbox), batch, and word-level export – work a general model can't do on a raw file. **Pepys never trains on your audio.**

Thin stdio wrapper over the Pepys [v1 REST API](https://pepys.co/developers). Phase-1 (BYO-key). OAuth/remote is on the roadmap.

## Install & configure

Requires **Node ≥ 18** and a Pepys API key (`pk_live_…`) from <https://pepys.co/developers>. **You get 60 free minutes on signup** – no card. Buy any pack once to unlock diarization, batch, and word-level export.

Run it with `npx` (no global install):

**Claude Desktop / Claude Code** – `claude_desktop_config.json` (or `claude mcp add`):

```json
{
  "mcpServers": {
    "pepys": {
      "command": "npx",
      "args": ["-y", "pepys-mcp"],
      "env": { "PEPYS_API_KEY": "pk_live_your_key_here" }
    }
  }
}
```

**Cursor** – `~/.cursor/mcp.json`, same shape. **Windsurf / other dev agents** – point them at `npx -y pepys-mcp` with `PEPYS_API_KEY` in the env.

Optional env: `PEPYS_API_BASE` (defaults to `https://pepys.co/api/v1`).

## Tools

| Tool | What it does |
|---|---|
| `transcribe` | Start a transcription from a `url` (file / YouTube / podcast / Drive) or a `file_ref`. Options: `diarize` (paid), `summary`, `chapters`, `translate_to`, `quality`, podcast `episode_guid`/`episode_index`. Returns `{ job_id, status }`. |
| `get_transcription` | Fetch a job by `job_id`; set `wait_ms:25000` to long-poll short clips to completion in one call. |
| `upload_file` | Upload local media (a `path` or `bytes_base64`) → a `file_ref` for `transcribe`. |
| `list_transcriptions` | Recent jobs (id, status, title, minutes). |
| `list_podcast_episodes` | Episodes of an RSS/Apple/Spotify feed, with `episode_guid`s. |
| `transcribe_podcast_feed` | Batch a whole feed (or latest N). **Paid.** |
| `export_transcript` | Export SRT / VTT / TXT / MD / JSON. Segment-level is free; `word_level:true` is a **paid** unlock. (DOCX/PDF: use the web app.) |
| `search_transcript` | Find a phrase in a long transcript → only the matching timestamped segments (no full-transcript context load). |
| `get_credit_balance` | Remaining credit minutes + whether Pro is unlocked. |

Also exposes finished transcripts as the resource `pepys://transcription/{id}` and a `transcribe_and_summarize` prompt.

**Billing over MCP:** two graceful prompts – `402` (out of minutes → top up at pepys.co/billing) and a Pro-feature upgrade message (diarization / batch / word-level → unlock with any one-time purchase). Segment exports, single transcription, links, and uploads are free on your minutes.

## Develop

```bash
npm install
npm run build      # tsc → dist/ (+ chmod the bin)
npm run smoke      # PEPYS_API_KEY=pk_live_… npm run smoke  – hits the live API to verify your key
```

## Publish

`npm run build && npm publish` (publishes `pepys-mcp`). Registry listings (MCP registry, mcp.so, Smithery, PulseMCP, Glama, `awesome-mcp-servers`) are submitted separately.

## License

MIT
