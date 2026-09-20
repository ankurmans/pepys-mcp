# pepys-mcp

> Transcription for AI agents, by **[Pepys](https://pepys.co)**.

The **Pepys transcription MCP server** – give any MCP-speaking agent (Claude, ChatGPT, Cursor, Gemini, open-source agents) speaker-labeled, timestamped transcription of audio and video: diarization, SRT/VTT captions, paste-a-link ingestion (YouTube, podcasts, Drive/Dropbox), batch, and word-level export. **Pepys never trains on your audio.**

The package runs locally over stdio with a Pepys API key. Pepys also hosts a production OAuth connector at `https://pepys.co/api/mcp` for compatible remote-MCP clients.

## Install & configure

Requires **Node ≥ 18** and a Pepys API key (`pk_live_…`) from <https://pepys.co/developers>. Some capabilities require an account entitlement.

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

### Claude Code plugin

This repo also bundles a Claude Code plugin that points at the hosted OAuth connector (no API key needed):

```
/plugin marketplace add ankurmans/pepys-mcp
/plugin install pepys
```

The first tool call opens an OAuth sign-in to your Pepys account. See [`skills/pepys/SKILL.md`](./skills/pepys/SKILL.md) for what it can do and example prompts.

## Tools

| Tool | What it does |
|---|---|
| `transcribe` | Start a transcription from a `url` (file / YouTube / podcast / Drive) or a `file_ref`. Options: `diarize` (entitlement required), `summary`, `chapters`, `translate_to`, `quality`, podcast `episode_guid`/`episode_index`. Returns `{ job_id, status }`. |
| `get_transcription` | Fetch a job by `job_id`; set `wait_ms:25000` to long-poll short clips to completion in one call. |
| `upload_file` | Upload local media (a `path` or `bytes_base64`) → a `file_ref` for `transcribe`. |
| `list_transcriptions` | Recent jobs (id, status, title, minutes). |
| `list_podcast_episodes` | Episodes of an RSS/Apple/Spotify feed, with `episode_guid`s. |
| `transcribe_podcast_feed` | Batch a whole feed (or latest N). Account entitlement required. |
| `export_transcript` | Export SRT / VTT / TXT / MD / JSON. Word-level timing requires an account entitlement. (DOCX/PDF: use the web app.) |
| `search_transcript` | Find a phrase in a long transcript → only the matching timestamped segments (no full-transcript context load). |
| `ask_transcription` | Answer a question about a transcript with server-verified, citation-backed claims only. |
| `get_credit_balance` | Remaining transcription balance and entitlement state. |

Also exposes finished transcripts as the resource `pepys://transcription/{id}` and a `transcribe_and_summarize` prompt.

**Account limits over MCP:** `402` returns an insufficient-balance result, while unavailable capabilities return a clear entitlement result and a supported fallback where one exists. The MCP server does not initiate purchases or link to checkout.

## Develop

```bash
npm install
npm run build      # tsc → dist/ (+ chmod the bin)
npm run smoke      # PEPYS_API_KEY=pk_live_… npm run smoke  – hits the live API to verify your key
```

## Publish

`npm run build && npm publish` (publishes `pepys-mcp`). Registry listings (MCP registry, mcp.so, Smithery, PulseMCP, Glama, `awesome-mcp-servers`) are submitted separately.

## About

Built by **[Pepys](https://pepys.co)**. Learn more at **[pepys.co](https://pepys.co)** · [MCP server](https://pepys.co/mcp) · [Developer docs](https://pepys.co/developers).

## License

MIT
