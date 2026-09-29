// Alternative provider: any vision-capable model on OpenRouter
// (https://openrouter.ai), reached through its OpenAI-compatible
// chat-completions API. Used when AI_PROVIDER=openrouter, or automatically
// when OPENROUTER_API_KEY is set and ANTHROPIC_API_KEY is not.

import { z } from "zod";
import { alignAnalysis, cleanTranscription } from "./claude.js";
import {
  ANALYZE_SYSTEM,
  TRANSCRIBE_SYSTEM,
  analyzeUserText,
  passageText,
} from "./prompts.js";
import {
  SentenceAnalysisSchema,
  TranscriptionSchema,
  type AnalyzeRequest,
  type SentenceAnalysis,
  type TranscribeRequest,
  type Transcription,
} from "./schemas.js";

export const openRouterConfig = {
  baseUrl: (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
  model: process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash",
  maxTokens: Number(process.env.OPENROUTER_MAX_TOKENS) || 16000,
};

/** A failure whose message can be shown to the user as is. */
export class OpenRouterError extends Error {}

interface StreamHooks {
  signal?: AbortSignal;
  onTextReset?: () => void;
  onText?: (delta: string) => void;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ChatMessage {
  role: "system" | "user";
  content: string | ContentPart[];
}

// Not every model on OpenRouter honors response_format, so the schema is
// also spelled out in the system prompt and the reply is parsed leniently.
function jsonInstructions(schema: z.ZodType): string {
  return `

Output format
Reply with a single JSON object and nothing else: no Markdown code fences, no commentary. It must match this JSON Schema:
${JSON.stringify(portableSchema(schema))}`;
}

function responseFormat(name: string, schema: z.ZodType) {
  return { type: "json_schema", json_schema: { name, strict: true, schema: portableSchema(schema) } };
}

/**
 * Zod's JSON Schema, trimmed to what strict structured-output modes accept:
 * no $schema or numeric bounds, and every object closed to extra keys.
 */
export function portableSchema(schema: z.ZodType): Record<string, unknown> {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$schema" || key === "minimum" || key === "maximum") continue;
      out[key] = clean(value);
    }
    if (out.type === "object") out.additionalProperties = false;
    return out;
  };
  return clean(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/** Streams a chat completion and returns the full reply text. */
async function streamChat(
  messages: ChatMessage[],
  format: ReturnType<typeof responseFormat>,
  hooks: StreamHooks,
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new OpenRouterError("The server has no OpenRouter API key. Set OPENROUTER_API_KEY and restart it.");
  }

  let res: Response;
  try {
    res = await fetch(`${openRouterConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Translatinate",
      },
      body: JSON.stringify({
        model: openRouterConfig.model,
        messages,
        response_format: format,
        max_tokens: openRouterConfig.maxTokens,
        stream: true,
      }),
      signal: hooks.signal,
    });
  } catch (err) {
    if (hooks.signal?.aborted) throw err;
    throw new OpenRouterError("The server couldn't reach OpenRouter.");
  }

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    let detail = body.slice(0, 300);
    try {
      detail = JSON.parse(body).error?.message ?? detail;
    } catch {
      // not JSON; keep the raw text
    }
    const hint =
      res.status === 401
        ? " Check OPENROUTER_API_KEY."
        : res.status === 402
          ? " Your OpenRouter account is out of credits."
          : res.status === 429
            ? " Rate limited; wait a moment and try again."
            : "";
    const sentence = /[.!?]$/.test(detail.trim()) ? detail.trim() : `${detail.trim()}.`;
    throw new OpenRouterError(`OpenRouter error (${res.status}): ${sentence}${hint}`);
  }

  // Server-sent events: "data: {json}" lines, ": comment" keep-alives, "data: [DONE]".
  hooks.onTextReset?.();
  let text = "";
  let finishReason: string | null = null;
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.error) {
        throw new OpenRouterError(`OpenRouter error: ${event.error.message ?? "unknown error"}`);
      }
      const choice = event.choices?.[0];
      const delta: unknown = choice?.delta?.content;
      if (typeof delta === "string" && delta) {
        text += delta;
        hooks.onText?.(delta);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  }

  if (finishReason === "length") {
    throw new OpenRouterError(
      "The response was too long and got cut off. Try a smaller section of the page, or raise OPENROUTER_MAX_TOKENS.",
    );
  }
  if (!text.trim()) throw new OpenRouterError("The model returned an empty response.");
  return text;
}

/** Parses JSON even if the model wrapped it in a code fence or added chatter. */
export function parseJsonReply<T>(text: string, schema: z.ZodType<T>): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let value: unknown;
  try {
    value = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
  } catch {
    throw new OpenRouterError(
      `The model (${openRouterConfig.model}) didn't return valid JSON. Try a different OPENROUTER_MODEL.`,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new OpenRouterError(
      `The model (${openRouterConfig.model}) returned JSON in the wrong shape. Try a different OPENROUTER_MODEL.`,
    );
  }
  return parsed.data;
}

export async function transcribeOpenRouter(
  input: TranscribeRequest,
  hooks: StreamHooks = {},
): Promise<Transcription> {
  const text = await streamChat(
    [
      { role: "system", content: TRANSCRIBE_SYSTEM + jsonInstructions(TranscriptionSchema) },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${input.mediaType};base64,${input.image}` } },
          { type: "text", text: "Transcribe this page and prepare it for the reader." },
        ],
      },
    ],
    responseFormat("transcription", TranscriptionSchema),
    hooks,
  );
  return cleanTranscription(parseJsonReply(text, TranscriptionSchema));
}

export async function analyzeOpenRouter(
  input: AnalyzeRequest,
  hooks: StreamHooks = {},
): Promise<SentenceAnalysis> {
  const text = await streamChat(
    [
      { role: "system", content: ANALYZE_SYSTEM + jsonInstructions(SentenceAnalysisSchema) },
      {
        role: "user",
        content: `${passageText(input.passage || input.sentence)}\n\n${analyzeUserText(input)}`,
      },
    ],
    responseFormat("sentence_analysis", SentenceAnalysisSchema),
    hooks,
  );
  return alignAnalysis(parseJsonReply(text, SentenceAnalysisSchema), input.words.length);
}
