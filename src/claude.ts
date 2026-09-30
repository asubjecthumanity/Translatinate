import { Anthropic } from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type {
  BetaContentBlock,
  MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  BLOCK_KINDS,
  SentenceAnalysisSchema,
  TranscriptionSchema,
  type BlockKind,
  type AnalyzeRequest,
  type SentenceAnalysis,
  type TranscribeRequest,
  type Transcription,
} from "./schemas.js";
import {
  ANALYZE_SYSTEM,
  TRANSCRIBE_SYSTEM,
  analyzeUserText,
  passageText,
} from "./prompts.js";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

function effortFromEnv(name: string, fallback: Effort): Effort {
  const value = process.env[name];
  return value && (EFFORTS as readonly string[]).includes(value) ? (value as Effort) : fallback;
}

export const config = {
  model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5",
  transcribeEffort: effortFromEnv("TRANSCRIBE_EFFORT", "medium"),
  analyzeEffort: effortFromEnv("ANALYZE_EFFORT", "medium"),
};

// If a safety classifier declines a request, the API re-runs it on the
// fallback model Anthropic recommends for that category, inside the same call.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** A response from Claude that we can't use (refused, truncated, malformed). */
export class ClaudeOutputError extends Error {}

let client: Anthropic | undefined;
function getClient(): Anthropic {
  // Credentials come from ANTHROPIC_API_KEY (or any other source the SDK resolves).
  return (client ??= new Anthropic());
}

const transcriptionFormat = betaZodOutputFormat(TranscriptionSchema);
const analysisFormat = betaZodOutputFormat(SentenceAnalysisSchema);

interface StreamHooks {
  signal?: AbortSignal;
  /** A new text block started; any text received so far is superseded. */
  onTextReset?: () => void;
  onText?: (delta: string) => void;
}

/**
 * Streams a structured-output request (streaming keeps long requests clear of
 * HTTP timeouts) and returns the JSON text of the final answer.
 */
async function streamJson(
  params: Omit<MessageCreateParamsStreaming, "model" | "stream">,
  hooks: StreamHooks,
): Promise<string> {
  const stream = getClient().beta.messages.stream(
    { ...params, model: config.model, betas: [FALLBACK_BETA], fallbacks: "default" },
    { signal: hooks.signal },
  );

  for await (const event of stream) {
    if (event.type === "content_block_start" && event.content_block.type === "text") {
      hooks.onTextReset?.();
    } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      hooks.onText?.(event.delta.text);
    }
  }
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new ClaudeOutputError("Claude declined to process this request.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new ClaudeOutputError(
      "The response was too long and got cut off. Try photographing a smaller section of the page.",
    );
  }

  // After a mid-stream fallback, only the content after the last `fallback`
  // block belongs to the answer that finished.
  const start = message.content.findLastIndex((block: BetaContentBlock) => block.type === "fallback") + 1;
  const text = message.content
    .slice(start)
    .map((block: BetaContentBlock) => (block.type === "text" ? block.text : ""))
    .join("");
  if (!text.trim()) {
    throw new ClaudeOutputError("Claude returned an empty response.");
  }
  return text;
}

function parseWith<T>(format: { parse: (content: string) => T }, text: string): T {
  try {
    return format.parse(text);
  } catch {
    throw new ClaudeOutputError("Claude returned a response in an unexpected format.");
  }
}

export async function transcribe(
  input: TranscribeRequest,
  hooks: StreamHooks = {},
): Promise<Transcription> {
  const text = await streamJson(
    {
      max_tokens: 32000,
      output_config: {
        effort: config.transcribeEffort,
        format: { type: "json_schema", schema: transcriptionFormat.schema },
      },
      system: TRANSCRIBE_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: input.mediaType, data: input.image },
            },
            { type: "text", text: "Transcribe this page and prepare it for the reader." },
          ],
        },
      ],
    },
    hooks,
  );
  return cleanTranscription(parseWith(transcriptionFormat, text));
}

export async function analyze(
  input: AnalyzeRequest,
  hooks: StreamHooks = {},
): Promise<SentenceAnalysis> {
  const text = await streamJson(
    {
      max_tokens: 32000,
      output_config: {
        effort: config.analyzeEffort,
        format: { type: "json_schema", schema: analysisFormat.schema },
      },
      system: ANALYZE_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            // Every sentence of a scan shares this passage, so cache the prefix
            // up to here and pay full price only for the sentence-specific part.
            {
              type: "text",
              text: passageText(input.passage || input.sentence),
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: analyzeUserText(input) },
          ],
        },
      ],
    },
    hooks,
  );
  return alignAnalysis(parseWith(analysisFormat, text), input.words.length);
}

/**
 * Normalizes whitespace and drops empty sentences and blocks. Verse keeps its
 * line breaks, including one at either end of a sentence (that is where a
 * line ends between two sentences); everything else is reflowed.
 */
export function cleanTranscription(t: Transcription): Transcription {
  const cleanText = (text: string, verse: boolean) =>
    verse
      ? text
          .replace(/[ \t]*\n\s*/g, "\n")
          .replace(/[ \t]+/g, " ")
          .replace(/^ +| +$/g, "")
      : text.replace(/\s+/g, " ").trim();

  const kindOf = (kind: string): BlockKind => {
    const k = kind.trim().toLowerCase();
    return (BLOCK_KINDS as readonly string[]).includes(k) ? (k as BlockKind) : "prose";
  };

  const blocks = t.blocks
    .map((block) => ({
      kind: kindOf(block.kind),
      sentences: block.sentences
        .map((s) => ({
          text: cleanText(s.text, kindOf(block.kind) === "verse"),
          translation: s.translation.trim(),
        }))
        .filter((s) => s.text.trim().length > 0),
    }))
    .filter((block) => block.sentences.length > 0);
  return {
    readable: t.readable && blocks.length > 0,
    title: t.title.trim(),
    source: t.source.trim(),
    about: t.about.trim(),
    notes: t.notes.trim(),
    blocks,
  };
}

/**
 * Keeps exactly one entry per word index, in order, and drops links that
 * point outside the sentence or back at the word itself.
 */
export function alignAnalysis(a: SentenceAnalysis, wordCount: number): SentenceAnalysis {
  const byIndex = new Map<number, SentenceAnalysis["words"][number]>();
  for (const word of a.words) {
    if (Number.isInteger(word.i) && word.i >= 0 && word.i < wordCount && !byIndex.has(word.i)) {
      byIndex.set(word.i, {
        ...word,
        links: [...new Set(word.links)].filter(
          (j) => Number.isInteger(j) && j >= 0 && j < wordCount && j !== word.i,
        ),
      });
    }
  }
  return {
    literal: a.literal,
    structure: a.structure,
    words: [...byIndex.keys()].sort((x, y) => x - y).map((i) => byIndex.get(i)!),
  };
}
