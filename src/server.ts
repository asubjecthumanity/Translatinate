import "./env.js";
import { timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { ClaudeOutputError, analyze, config, transcribe } from "./claude.js";
import { mockAnalyze, mockTranscribe } from "./mock.js";
import {
  OpenRouterError,
  analyzeOpenRouter,
  openRouterConfig,
  transcribeOpenRouter,
} from "./openrouter.js";
import { AnalyzeRequestSchema, TranscribeRequestSchema } from "./schemas.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PASSCODE = process.env.APP_PASSCODE || "";
const MOCK = process.env.MOCK_CLAUDE === "1";

// Which AI service does the work. Defaults to Claude; switches to OpenRouter
// when asked to, or when only an OpenRouter key is configured.
const PROVIDER: "anthropic" | "openrouter" =
  process.env.AI_PROVIDER === "openrouter" ||
  (!process.env.AI_PROVIDER && Boolean(process.env.OPENROUTER_API_KEY) && !process.env.ANTHROPIC_API_KEY)
    ? "openrouter"
    : "anthropic";

const app = express();
app.disable("x-powered-by");
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url)), { extensions: ["html"] }));
app.use("/api", express.json({ limit: "8mb" }));

// ---------------------------------------------------------------------------
// Optional passcode, so a public deployment doesn't spend your credits for
// strangers. The browser asks for it once and sends it on every request.
// ---------------------------------------------------------------------------

function passcodeMatches(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(PASSCODE);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.get("/api/config", (_req, res) => {
  res.json({ passcodeRequired: Boolean(PASSCODE), mock: MOCK });
});

app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (!PASSCODE || passcodeMatches(req.get("x-passcode") ?? "")) return next();
  res.status(401).json({ error: "Passcode required.", code: "passcode" });
});

// ---------------------------------------------------------------------------
// Claude calls can run for a minute or more, so responses are streamed as
// newline-delimited JSON: progress and keep-alive lines, then one final
// {"type":"result"} or {"type":"error"} line. This keeps proxies from timing
// the connection out and lets the phone show live progress.
// ---------------------------------------------------------------------------

type StreamLine =
  | { type: "ping" }
  | { type: "reset" }
  | { type: "text"; text: string }
  | { type: "result"; data: unknown }
  | { type: "error"; message: string };

function openStream(res: Response) {
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (line: StreamLine) => {
    if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(line) + "\n");
  };
  const heartbeat = setInterval(() => send({ type: "ping" }), 10_000);

  // Coalesce text deltas so the phone isn't flooded with tiny writes.
  let pending = "";
  let flushTimer: NodeJS.Timeout | undefined;
  const flushText = () => {
    flushTimer = undefined;
    if (pending) send({ type: "text", text: pending });
    pending = "";
  };

  // If the phone goes away mid-request, stop the timers and cancel the Claude call.
  const abort = new AbortController();
  res.on("close", () => {
    clearInterval(heartbeat);
    clearTimeout(flushTimer);
    if (!res.writableFinished) abort.abort(new Error("Client disconnected"));
  });

  return {
    signal: abort.signal,
    onTextReset() {
      pending = "";
      send({ type: "reset" });
    },
    onText(delta: string) {
      pending += delta;
      flushTimer ??= setTimeout(flushText, 150);
    },
    finish(line: StreamLine) {
      clearInterval(heartbeat);
      clearTimeout(flushTimer);
      flushText();
      send(line);
      res.end();
    },
  };
}

function describeError(err: unknown): string {
  if (err instanceof ClaudeOutputError || err instanceof OpenRouterError) return err.message;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return "The server's Anthropic API key was rejected. Check ANTHROPIC_API_KEY.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Too many requests to Claude right now. Wait a moment and try again.";
  }
  if (err instanceof Anthropic.BadRequestError) {
    return `Claude couldn't accept this request: ${err.message}`;
  }
  if (err instanceof Anthropic.InternalServerError) {
    return "Claude is overloaded or had an error. Try again in a moment.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "The server couldn't reach the Claude API.";
  }
  if (err instanceof Anthropic.APIError) {
    return `Claude API error${err.status ? ` (${err.status})` : ""}: ${err.message}`;
  }
  if (err instanceof Anthropic.AnthropicError && /authentication/i.test(err.message)) {
    return "The server has no Anthropic API key. Set ANTHROPIC_API_KEY and restart it.";
  }
  return "Something went wrong on the server.";
}

function streamHandler<Body>(
  schema: z.ZodType<Body>,
  run: (body: Body, hooks: ReturnType<typeof openStream>) => Promise<unknown>,
) {
  return async (req: Request, res: Response) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
      return;
    }
    const stream = openStream(res);
    try {
      const data = await run(parsed.data, stream);
      stream.finish({ type: "result", data });
    } catch (err) {
      if (stream.signal.aborted) return; // the phone went away; nobody to tell
      console.error(`${req.path} failed:`, err);
      stream.finish({ type: "error", message: describeError(err) });
    }
  };
}

app.post(
  "/api/transcribe",
  streamHandler(TranscribeRequestSchema, (body, hooks) =>
    MOCK
      ? mockTranscribe(hooks)
      : PROVIDER === "openrouter"
        ? transcribeOpenRouter(body, hooks)
        : transcribe(body, hooks),
  ),
);

app.post(
  "/api/analyze",
  streamHandler(AnalyzeRequestSchema, (body, hooks) =>
    MOCK
      ? mockAnalyze(body, hooks)
      : PROVIDER === "openrouter"
        ? analyzeOpenRouter(body, hooks)
        : analyze(body, hooks),
  ),
);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found." });
});

// Body-parser errors (oversized or malformed JSON) land here.
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
  res.status(status).json({
    error: status === 413 ? "That photo is too large to upload." : status < 500 ? err.message : "Server error.",
  });
});

/** Addresses a phone on the same Wi-Fi can use to reach this computer. */
function lanUrls(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((net) => net && net.family === "IPv4" && !net.internal)
    .map((net) => `http://${net!.address}:${PORT}`);
}

app.listen(PORT, HOST, () => {
  console.log(`Translatinate listening on http://localhost:${PORT}`);
  if (HOST === "0.0.0.0") {
    for (const url of lanUrls()) console.log(`  on your phone (same Wi-Fi): ${url}`);
  }
  if (MOCK) {
    console.log("MOCK_CLAUDE=1: serving the bundled sample instead of calling Claude.");
  } else if (PROVIDER === "openrouter") {
    console.log(`Using OpenRouter, model ${openRouterConfig.model}.`);
    if (!process.env.OPENROUTER_API_KEY) {
      console.warn("Warning: OPENROUTER_API_KEY is not set; requests will fail.");
    }
  } else {
    console.log(
      `Using Claude, model ${config.model} (transcribe effort ${config.transcribeEffort}, analyze effort ${config.analyzeEffort}).`,
    );
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      console.warn("Warning: ANTHROPIC_API_KEY is not set; requests to Claude will fail.");
    }
  }
  if (!PASSCODE) {
    console.log("No APP_PASSCODE set: anyone who can reach this server can use it.");
  }
});
