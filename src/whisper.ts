import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { getSettings } from "./config";

// Voice transcription is API-only. Audio files are uploaded directly to an
// OpenAI-compatible speech-to-text endpoint (Groq by default). No local
// whisper.cpp binary, model download, or audio transcoding is involved —
// Groq accepts Telegram's .ogg/.oga opus voice notes as-is.

const DEFAULT_STT_BASE_URL = "https://api.groq.com/openai";
const DEFAULT_STT_MODEL = "whisper-large-v3";

type WhisperDebugLog = (message: string) => void;

function noopLog(): void {}

async function transcribeViaApi(
  inputPath: string,
  baseUrl: string,
  model: string,
  apiKey: string,
  log: WhisperDebugLog
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/audio/transcriptions`;
  log(`voice transcribe: using STT API url=${url} model=${model}`);

  const audioBytes = await readFile(inputPath);
  const ext = extname(inputPath).toLowerCase().replace(".", "") || "ogg";
  const mimeMap: Record<string, string> = {
    ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav",
    mp3: "audio/mpeg", m4a: "audio/mp4", webm: "audio/webm",
  };
  const mimeType = mimeMap[ext] ?? "audio/ogg";

  const form = new FormData();
  form.append("file", new Blob([audioBytes], { type: mimeType }), `audio.${ext}`);
  form.append("model", model);

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`STT API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { text?: string };
  const transcript = (data.text ?? "").trim();
  log(`voice transcribe: API transcript chars=${transcript.length}`);
  return transcript;
}

export async function transcribeAudioToText(
  inputPath: string,
  options?: { debug?: boolean; log?: WhisperDebugLog }
): Promise<string> {
  const log = options?.debug ? (options?.log ?? console.log) : noopLog;

  const stt = getSettings().stt;
  const apiKey = stt?.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "Voice transcription is not configured. Set a Groq API key via stt.apiKey in settings or the GROQ_API_KEY env var."
    );
  }

  const baseUrl = stt?.baseUrl?.trim() || DEFAULT_STT_BASE_URL;
  const model = stt?.model?.trim() || DEFAULT_STT_MODEL;
  return transcribeViaApi(inputPath, baseUrl, model, apiKey, log);
}
