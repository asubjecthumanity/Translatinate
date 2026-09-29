import assert from "node:assert/strict";
import { test } from "node:test";
import { alignAnalysis, cleanTranscription } from "../src/claude.js";
import type { SentenceAnalysis, Transcription } from "../src/schemas.js";

const base: Transcription = {
  readable: true,
  title: " Title ",
  source: "",
  about: "",
  notes: "",
  blocks: [],
};

test("prose is reflowed and trimmed", () => {
  const t = cleanTranscription({
    ...base,
    blocks: [{ kind: "prose", sentences: [{ text: "  Gallia est\nomnis   divisa. ", translation: " x " }] }],
  });
  assert.equal(t.title, "Title");
  assert.deepEqual(t.blocks[0].sentences[0], { text: "Gallia est omnis divisa.", translation: "x" });
});

test("verse keeps line breaks, including at sentence edges", () => {
  const t = cleanTranscription({
    ...base,
    blocks: [
      {
        kind: "verse",
        sentences: [
          { text: "Arma virumque cano, Troiae qui primus ab oris \n  Italiam fato profugus\n", translation: "" },
          { text: "Laviniaque venit litora.", translation: "" },
        ],
      },
    ],
  });
  assert.equal(
    t.blocks[0].sentences[0].text,
    "Arma virumque cano, Troiae qui primus ab oris\nItaliam fato profugus\n",
  );
  assert.equal(t.blocks[0].sentences[1].text, "Laviniaque venit litora.");
});

test("unknown block kinds become prose; empty sentences and blocks are dropped", () => {
  const t = cleanTranscription({
    ...base,
    blocks: [
      { kind: "Paragraph", sentences: [{ text: "Hi omnes differunt.", translation: "" }] },
      { kind: "verse", sentences: [{ text: " \n ", translation: "" }] },
      { kind: " HEADING ", sentences: [{ text: "Liber I", translation: "" }] },
    ],
  });
  assert.deepEqual(
    t.blocks.map((b) => b.kind),
    ["prose", "heading"],
  );
});

test("a transcription with no text is not readable", () => {
  assert.equal(cleanTranscription({ ...base, blocks: [] }).readable, false);
});

test("alignAnalysis keeps one entry per valid index, sorted, with clean links", () => {
  const word = (i: number, links: number[]) => ({
    i,
    form: `w${i}`,
    lemma: "",
    pos: "",
    parse: "",
    meaning_here: "",
    role: "",
    definitions: [],
    links,
    derivatives: [],
    note: "",
  });
  const a: SentenceAnalysis = {
    literal: "l",
    structure: "s",
    words: [word(2, [0, 2, 9, 0]), word(0, [1]), word(0, []), word(5, []), word(-1, [])],
  };
  const out = alignAnalysis(a, 3);
  assert.deepEqual(
    out.words.map((w) => [w.i, w.links]),
    [
      [0, [1]],
      [2, [0]],
    ],
  );
});
