// Talks to the server. Long-running calls stream newline-delimited JSON:
// {"type":"text"} / {"type":"reset"} progress lines and pings, then a final
// {"type":"result"} or {"type":"error"}.

const PASSCODE_KEY = "translatinate.passcode";

export class PasscodeError extends Error {}

function readPasscode() {
  try {
    return localStorage.getItem(PASSCODE_KEY) || "";
  } catch {
    return "";
  }
}

export function savePasscode(value) {
  try {
    localStorage.setItem(PASSCODE_KEY, value);
  } catch {
    // Storage unavailable (private mode); it will be asked for again.
  }
}

export async function getConfig() {
  try {
    const res = await fetch("/api/config");
    if (res.ok) return await res.json();
  } catch {
    // Offline or server down; the first real request will report it.
  }
  return { passcodeRequired: false, mock: false };
}

/**
 * @param {string} path
 * @param {unknown} body
 * @param {{signal?: AbortSignal, onText?: (t: string) => void, onReset?: () => void}} [opts]
 */
async function streamRequest(path, body, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Passcode": readPasscode() },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new Error("Couldn't reach the server. Check your connection.");
  }

  if (res.status === 401) throw new PasscodeError("Passcode required.");
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `Server error (${res.status}).`);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.type === "text") opts.onText?.(msg.text);
      else if (msg.type === "reset") opts.onReset?.();
      else if (msg.type === "result") return msg.data;
      else if (msg.type === "error") throw new Error(msg.message);
    }
  }
  throw new Error("The connection closed before the server finished. Try again.");
}

/** @param {{image: string, mediaType: string}} photo */
export function transcribe(photo, opts) {
  return streamRequest("/api/transcribe", photo, opts);
}

/** @param {{passage: string, sentence: string, translation: string, words: string[]}} input */
export function analyze(input, opts) {
  return streamRequest("/api/analyze", input, opts);
}
