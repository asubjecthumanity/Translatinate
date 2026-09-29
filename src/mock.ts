// Offline stand-in for the Claude calls, enabled with MOCK_CLAUDE=1. It serves
// the bundled sample passage so the whole app can be tried and tested without
// an API key. Whatever photo is uploaded, the sample is what comes back.

import { readFile } from "node:fs/promises";
import type {
  AnalyzeRequest,
  SentenceAnalysis,
  Transcription,
} from "./schemas.js";

interface Sample {
  transcription: Transcription;
  analyses: Record<string, SentenceAnalysis>;
}

let sample: Promise<Sample> | undefined;
function loadSample(): Promise<Sample> {
  return (sample ??= readFile(new URL("../public/sample/sample.json", import.meta.url), "utf8").then(
    (text) => JSON.parse(text) as Sample,
  ));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

export async function mockTranscribe(hooks: {
  signal?: AbortSignal;
  onTextReset?: () => void;
  onText?: (delta: string) => void;
}): Promise<Transcription> {
  const { transcription } = await loadSample();
  await sleep(1200, hooks.signal); // "thinking"
  const json = JSON.stringify(transcription);
  hooks.onTextReset?.();
  for (let i = 0; i < json.length; i += 40) {
    hooks.onText?.(json.slice(i, i + 40));
    await sleep(25, hooks.signal);
  }
  return transcription;
}

export async function mockAnalyze(
  input: AnalyzeRequest,
  hooks: { signal?: AbortSignal },
): Promise<SentenceAnalysis> {
  const { transcription, analyses } = await loadSample();
  await sleep(1500, hooks.signal);
  for (const [b, block] of transcription.blocks.entries()) {
    for (const [s, sentence] of block.sentences.entries()) {
      const canned = analyses[`${b}.${s}`];
      if (sentence.text === input.sentence && canned) return canned;
    }
  }
  return {
    literal: "(mock mode: no canned analysis for this sentence)",
    structure: "",
    words: input.words.map((form, i) => ({
      i,
      form,
      lemma: form,
      pos: "unknown",
      parse: "",
      meaning_here: "",
      role: "",
      definitions: [],
      links: [],
      derivatives: [],
      note: "Mock mode is on (MOCK_CLAUDE=1), so this word was not analyzed.",
    })),
  };
}
