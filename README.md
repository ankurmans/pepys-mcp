# Pepys plugin for Claude Code

Transcribe audio, video, and podcasts with [Pepys](https://pepys.co) without leaving Claude
Code: speaker diarization, timed SRT/VTT captions, paste-a-link ingestion (YouTube, podcasts,
Google Drive/Dropbox), whole-feed batch transcription, and transcript search – all through the
Pepys MCP connector at `https://pepys.co/api/mcp`.

## Install

```
/plugin marketplace add ankurmans/pepys-claude-plugin
/plugin install pepys
```

The first tool call opens an OAuth sign-in to your Pepys account (or creates one). No API key
needed. Usage bills to your Pepys credits – 1 credit = 1 minute, credits never expire, and the
free tier includes 60 minutes.

## What's included

- `.mcp.json` – points at the hosted Pepys MCP server (`https://pepys.co/api/mcp`), the same
  connector listed in Anthropic's Connectors Directory.
- `skills/pepys/SKILL.md` – tells Claude when and how to use it, with example prompts.

## Tools

`transcribe`, `get_transcription`, `upload_file`, `list_transcriptions`,
`list_podcast_episodes`, `transcribe_podcast_feed`, `export_transcript`, `search_transcript`,
`ask_transcription`, `get_credit_balance`.

Full docs: [pepys.co/mcp](https://pepys.co/mcp) · [pepys.co/developers](https://pepys.co/developers).

## License

MIT
