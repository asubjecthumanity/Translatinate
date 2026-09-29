// Splits a sentence into words (tappable) and everything else (spaces,
// punctuation, line breaks). The server receives the word list produced here,
// so word indices in an analysis always line up with what is on screen.

const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;

/**
 * @param {string} text
 * @returns {Array<{type: "word", text: string, i: number} | {type: "text", text: string} | {type: "br"}>}
 */
export function tokenize(text) {
  const parts = [];
  let last = 0;
  let i = 0;
  const pushText = (chunk) => {
    const lines = chunk.split("\n");
    lines.forEach((line, n) => {
      if (n > 0) parts.push({ type: "br" });
      if (line) parts.push({ type: "text", text: line });
    });
  };
  for (const match of text.matchAll(WORD)) {
    if (match.index > last) pushText(text.slice(last, match.index));
    parts.push({ type: "word", text: match[0], i: i++ });
    last = match.index + match[0].length;
  }
  if (last < text.length) pushText(text.slice(last));
  return parts;
}

/** @param {string} text */
export function words(text) {
  return Array.from(text.matchAll(WORD), (m) => m[0]);
}
