#!/usr/bin/env node
// Smoke-test the Pepys v1 API that pepys-mcp wraps. Run with a real key:
//   PEPYS_API_KEY=pk_live_… npm run smoke
// Optionally exercise a full transcribe→poll→export cycle by also passing a public media URL:
//   PEPYS_API_KEY=pk_live_… SMOKE_URL="https://…/clip.mp3" npm run smoke
// No dependencies – Node ≥ 18 (global fetch).

const BASE = (process.env.PEPYS_API_BASE ?? "https://pepys.co/api/v1").replace(/\/$/, "");
const KEY = process.env.PEPYS_API_KEY;
const URL_TO_TEST = process.env.SMOKE_URL;

if (!KEY) {
  console.error("Set PEPYS_API_KEY (pk_live_…). Get one at https://pepys.co/developers");
  process.exit(2);
}

let pass = 0;
let fail = 0;
const ok = (m) => (console.log(`  ✓ ${m}`), pass++);
const bad = (m) => (console.log(`  ✗ ${m}`), fail++);

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${KEY}`,
      Accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await res.json().catch(() => ({})) : await res.text();
  return { status: res.status, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Pepys MCP smoke test → ${BASE}\n`);

  console.log("credits (get_credit_balance):");
  const c = await api("/credits");
  if (c.status === 200 && typeof c.data.minutes === "number") {
    ok(`balance = ${c.data.minutes} min, is_paid = ${c.data.is_paid}`);
  } else if (c.status === 401) {
    bad("401 – key invalid. Check PEPYS_API_KEY.");
    process.exit(1);
  } else {
    bad(`unexpected ${c.status}: ${JSON.stringify(c.data)}`);
  }

  console.log("\nlist (list_transcriptions):");
  const l = await api("/transcriptions");
  if (l.status === 200 && Array.isArray(l.data.data)) ok(`${l.data.data.length} recent job(s)`);
  else bad(`unexpected ${l.status}`);

  if (!URL_TO_TEST) {
    console.log("\n(Set SMOKE_URL to a public media link to test transcribe→poll→export.)");
  } else {
    console.log(`\ntranscribe (${URL_TO_TEST}):`);
    const t = await api("/transcriptions", { method: "POST", body: { url: URL_TO_TEST } });
    if ((t.status === 202 || t.status === 200) && t.data.id) {
      ok(`job ${t.data.id} (${t.data.status})`);
      const id = t.data.id;

      console.log("\npoll (get_transcription):");
      let done = null;
      for (let i = 0; i < 40; i++) {
        const g = await api(`/transcriptions/${encodeURIComponent(id)}`);
        if (g.data.status === "done") { done = g.data; break; }
        if (g.data.status === "failed" || g.data.status === "canceled") { bad(`job ${g.data.status}: ${g.data.error}`); break; }
        await sleep(3000);
      }
      if (done) {
        ok(`done: ${done.duration_seconds}s, ${done.segments?.length ?? 0} segments, ${done.language}`);

        console.log("\nexport srt (export_transcript, free):");
        const e = await api(`/transcriptions/${encodeURIComponent(id)}/export?format=srt`);
        if (e.status === 200 && typeof e.data === "string" && e.data.includes("-->")) ok("got SRT");
        else bad(`unexpected ${e.status}`);

        console.log("\nexport word-level (export_transcript, paid gate):");
        const w = await api(`/transcriptions/${encodeURIComponent(id)}/export?format=json&word_level=true`);
        if (w.status === 403 && w.data.upgrade) ok("403 upgrade (as expected on a free account)");
        else if (w.status === 200) ok("got word-level JSON (paid account)");
        else if (w.status === 409) ok("409 no word timing (caption source)");
        else bad(`unexpected ${w.status}`);
      } else {
        bad("job did not finish within ~2 min");
      }
    } else {
      bad(`transcribe returned ${t.status}: ${JSON.stringify(t.data)}`);
    }
  }

  console.log(`\n${fail === 0 ? "✅ all checks passed" : `❌ ${fail} check(s) failed`} (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(1);
});
