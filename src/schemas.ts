import { z } from "zod";

// ---------------------------------------------------------------------------
// Step 1 — transcription of the photographed page.
// ---------------------------------------------------------------------------

export const SentenceSchema = z.object({
  text: z
    .string()
    .describe(
      'The Latin sentence exactly as transcribed. Use "\\n" only where a verse line breaks.',
    ),
  translation: z.string().describe("A natural, accurate English translation."),
});

export const BLOCK_KINDS = ["heading", "prose", "verse"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const BlockSchema = z.object({
  // The SDK's Zod helper sends enums to the API only as a description hint,
  // so accept any string here and normalize it in cleanTranscription().
  kind: z.string().describe('One of "heading", "prose" or "verse".'),
  sentences: z.array(SentenceSchema),
});

export const TranscriptionSchema = z.object({
  readable: z
    .boolean()
    .describe("false when the image contains no legible Latin text."),
  title: z.string().describe("Short title for the passage."),
  source: z
    .string()
    .describe('Author, work and location if identified with confidence, else "".'),
  about: z.string().describe("1–3 sentences orienting a student to the passage."),
  notes: z
    .string()
    .describe('Notes on the transcription (normalizations, gaps, doubts), or "".'),
  blocks: z.array(BlockSchema),
});

export type Transcription = z.infer<typeof TranscriptionSchema>;

// ---------------------------------------------------------------------------
// Step 2 — word-by-word analysis of one sentence.
// ---------------------------------------------------------------------------

export const WordAnalysisSchema = z.object({
  i: z.number().int().describe("The word's number, copied from the list."),
  form: z.string().describe("The word exactly as it appears in the list."),
  lemma: z.string().describe("Dictionary headword with principal parts / genitive and gender."),
  pos: z.string().describe("Part of speech, lowercase."),
  parse: z.string().describe("Full morphological parse of this form in this context."),
  meaning_here: z.string().describe("Best English rendering of the word in this sentence."),
  role: z.string().describe("Its syntactic function in this sentence, in plain English."),
  definitions: z.array(z.string()).describe("2–4 main dictionary senses, most relevant first."),
  links: z
    .array(z.number().int())
    .describe("Numbers of the words in this sentence it is grammatically tied to."),
  derivatives: z.array(z.string()).describe("Up to 3 English derivatives."),
  note: z.string().describe('Optional short note for a learner, or "".'),
});

export const SentenceAnalysisSchema = z.object({
  literal: z.string().describe("A close, word-for-word literal translation."),
  structure: z.string().describe("How the sentence is built, in 1–3 sentences."),
  words: z.array(WordAnalysisSchema),
});

export type WordAnalysis = z.infer<typeof WordAnalysisSchema>;
export type SentenceAnalysis = z.infer<typeof SentenceAnalysisSchema>;

// ---------------------------------------------------------------------------
// Request bodies accepted by the HTTP API.
// ---------------------------------------------------------------------------

// Claude accepts images up to 5 MB; base64 inflates by 4/3.
const MAX_IMAGE_BASE64_CHARS = Math.floor((5 * 1024 * 1024 * 4) / 3);

export const TranscribeRequestSchema = z.object({
  image: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS, "Image is larger than 5 MB."),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
});

export const AnalyzeRequestSchema = z.object({
  passage: z.string().max(60_000),
  sentence: z.string().min(1).max(5_000),
  translation: z.string().max(10_000).default(""),
  words: z.array(z.string().min(1).max(100)).min(1).max(300),
});

export type TranscribeRequest = z.infer<typeof TranscribeRequestSchema>;
export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;
