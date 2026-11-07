import "server-only";
import { env } from "@/lib/env";

/**
 * Transcribes a recorded call: ElevenLabs Scribe first, Deepgram second (VOICE_STT_PROVIDERS),
 * each rotating over its keys. Speakers are labelled ("Speaker 1: …") so the summary can tell the
 * mentor from the candidate. Indian English with some Hindi / Telugu is common, so the language
 * is detected per file.
 */

export interface Transcript {
  text: string;
  provider: string;
  durationSec: number | null;
}

let rr = 0;
const rotate = <T,>(list: T[]): T[] => {
  if (!list.length) return list;
  const start = rr++ % list.length;
  return [...list.slice(start), ...list.slice(0, start)];
};

async function elevenLabs(audio: Buffer, mime: string, key: string): Promise<Transcript> {
  const form = new FormData();
  form.append("model_id", "scribe_v1");
  form.append("diarize", "true");
  form.append("tag_audio_events", "false");
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), "call");
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string; words?: { text: string; type?: string; speaker_id?: string; end?: number }[] };
  const words = json.words ?? [];
  // Group words by speaker into lines.
  const lines: string[] = [];
  let current = "";
  let speaker = "";
  let last = 0;
  for (const w of words) {
    if (w.type === "spacing") {
      current += w.text;
      continue;
    }
    if (typeof w.end === "number") last = Math.max(last, w.end);
    const s = w.speaker_id ?? "";
    if (s !== speaker) {
      if (current.trim()) lines.push(`${label(speaker)}: ${current.trim()}`);
      speaker = s;
      current = "";
    }
    current += w.text;
  }
  if (current.trim()) lines.push(`${label(speaker)}: ${current.trim()}`);
  const text = lines.length ? lines.join("\n") : (json.text ?? "").trim();
  return { text, provider: "elevenlabs", durationSec: last ? Math.round(last) : null };
}

const label = (speakerId: string) => {
  const n = Number(speakerId.replace(/\D/g, ""));
  return Number.isFinite(n) && speakerId ? `Speaker ${n + 1}` : "Speaker";
};

async function deepgram(audio: Buffer, mime: string, key: string): Promise<Transcript> {
  const res = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&utterances=true&detect_language=true", {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": mime || "audio/mpeg" },
    body: new Uint8Array(audio),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Deepgram ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as {
    metadata?: { duration?: number };
    results?: { utterances?: { speaker?: number; transcript: string }[]; channels?: { alternatives?: { transcript?: string }[] }[] };
  };
  const utterances = json.results?.utterances ?? [];
  const text = utterances.length
    ? utterances.map((u) => `Speaker ${(u.speaker ?? 0) + 1}: ${u.transcript}`).join("\n")
    : (json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
  return { text, provider: "deepgram", durationSec: json.metadata?.duration ? Math.round(json.metadata.duration) : null };
}

export async function transcribe(audio: Buffer, mime: string): Promise<Transcript> {
  const errors: string[] = [];
  for (const provider of env.voice.sttProviders) {
    const keys = rotate(provider === "elevenlabs" ? env.voice.elevenLabsKeys : env.voice.deepgramKeys);
    for (const key of keys) {
      try {
        const t = provider === "elevenlabs" ? await elevenLabs(audio, mime, key) : await deepgram(audio, mime, key);
        if (t.text.trim()) return t;
        errors.push(`${provider}: empty transcript`);
        break; // an empty result won't change with another key
      } catch (err) {
        errors.push(err instanceof Error ? err.message.slice(0, 160) : String(err));
      }
    }
  }
  throw new Error(`The call couldn't be transcribed (${errors.slice(-2).join(" | ") || "no speech-to-text keys"}).`);
}
