import assert from "node:assert/strict";
import { test } from "node:test";
import { tokenize, words } from "../public/js/tokenize.js";

test("splits words from punctuation and numbers words in order", () => {
  const parts = tokenize("Gallia est omnis divisa in partes tres, quarum unam…");
  const ws = parts.filter((p: { type: string }) => p.type === "word");
  assert.deepEqual(
    ws.map((w: { text: string; i: number }) => [w.i, w.text]),
    [
      [0, "Gallia"], [1, "est"], [2, "omnis"], [3, "divisa"], [4, "in"],
      [5, "partes"], [6, "tres"], [7, "quarum"], [8, "unam"],
    ],
  );
  assert.equal(parts.map((p: { text?: string }) => p.text ?? "\n").join(""), "Gallia est omnis divisa in partes tres, quarum unam…");
});

test("keeps macrons, ligatures and enclitics inside words", () => {
  assert.deepEqual(words("Senātus populusque Rōmānus; cælum, fœdus."), [
    "Senātus", "populusque", "Rōmānus", "cælum", "fœdus",
  ]);
});

test("turns newlines into line breaks", () => {
  const parts = tokenize("oris\nItaliam");
  assert.deepEqual(parts, [
    { type: "word", text: "oris", i: 0 },
    { type: "br" },
    { type: "word", text: "Italiam", i: 1 },
  ]);
});

test("gap markers and numbers are not words", () => {
  assert.deepEqual(words("Cap. 12. Gallia […] divisa"), ["Cap", "Gallia", "divisa"]);
});
