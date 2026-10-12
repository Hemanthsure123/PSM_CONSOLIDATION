import "server-only";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "@/lib/env";

/**
 * Lazily-constructed singleton Google Gemini client. Lazy + cached on
 * `globalThis` (see bigquery.ts for the rationale).
 *
 * Model defaults to `gemini-1.5-flash` and is overridable via GEMINI_MODEL.
 */
const globalForGemini = globalThis as unknown as {
  gemini?: GoogleGenerativeAI;
  geminiByKey?: Map<string, GoogleGenerativeAI>;
};

export function getGemini(): GoogleGenerativeAI {
  if (!globalForGemini.gemini) {
    globalForGemini.gemini = new GoogleGenerativeAI(env.gemini.apiKey);
  }
  return globalForGemini.gemini;
}

/**
 * A Gemini client for a SPECIFIC api key, cached per-key on `globalThis`. Used by
 * the DSA link-extraction step to round-robin across a pool of keys.
 */
export function getGeminiForKey(apiKey: string): GoogleGenerativeAI {
  if (!globalForGemini.geminiByKey) globalForGemini.geminiByKey = new Map();
  let client = globalForGemini.geminiByKey.get(apiKey);
  if (!client) {
    client = new GoogleGenerativeAI(apiKey);
    globalForGemini.geminiByKey.set(apiKey, client);
  }
  return client;
}

export function geminiModel(): string {
  return env.gemini.model;
}
