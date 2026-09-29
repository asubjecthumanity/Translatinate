// The reading view: renders a transcription as tappable words, shows the word
// sheet, and analyzes sentences in the background (the one you tap first).

import { tokenize } from "./tokenize.js";

const TEXT_SIZES = [18, 20, 22, 25, 28];
const PREFS_KEY = "translatinate.prefs";

/** Tiny DOM builder. Children are strings or nodes; strings are always text. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

function loadPrefs() {
  try {
    return { size: 2, translation: false, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch {
    return { size: 2, translation: false };
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not persisted; fine.
  }
}

/** Plain text of the whole passage, used as context for each analysis. */
export function passageOf(transcription) {
  return transcription.blocks
    .map((block) => block.sentences.map((s) => s.text).join(" "))
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Background analysis queue
// ---------------------------------------------------------------------------

class AnalysisQueue {
  /**
   * @param {object} opts
   * @param {string[]} opts.sids sentence ids in reading order
   * @param {(sid: string) => boolean} opts.isDone
   * @param {(sid: string, signal: AbortSignal) => Promise<void>} opts.run
   * @param {() => void} opts.onChange
   */
  constructor({ sids, isDone, run, onChange, concurrency = 3 }) {
    this.isDone = isDone;
    this.runOne = run;
    this.onChange = onChange;
    this.concurrency = concurrency;
    this.all = sids;
    this.waiting = sids.filter((sid) => !isDone(sid));
    this.active = new Map(); // sid -> AbortController
    this.errors = new Map(); // sid -> message
    this.stopped = false;
  }

  status(sid) {
    if (this.isDone(sid)) return "done";
    if (this.active.has(sid)) return "loading";
    if (this.errors.has(sid)) return "error";
    return "pending";
  }

  counts() {
    const done = this.all.filter((sid) => this.isDone(sid)).length;
    return { done, total: this.all.length, failed: this.errors.size };
  }

  start() {
    this.pump();
  }

  /** Move a sentence to the front of the line (retrying it if it failed). */
  prioritize(sid) {
    if (this.stopped || this.isDone(sid) || this.active.has(sid)) return;
    this.waiting = [sid, ...this.waiting.filter((s) => s !== sid)];
    if (this.errors.delete(sid)) this.onChange(sid);
    this.pump();
  }

  retryFailed() {
    const failed = [...this.errors.keys()];
    this.errors.clear();
    this.waiting.push(...failed.filter((sid) => !this.waiting.includes(sid)));
    this.pump();
  }

  stop() {
    this.stopped = true;
    for (const ctrl of this.active.values()) ctrl.abort();
    this.active.clear();
  }

  pump() {
    while (!this.stopped && this.active.size < this.concurrency && this.waiting.length) {
      const sid = this.waiting.shift();
      if (this.isDone(sid) || this.active.has(sid)) continue;
      const ctrl = new AbortController();
      this.active.set(sid, ctrl);
      this.errors.delete(sid);
      this.onChange(sid);
      this.runOne(sid, ctrl.signal)
        .catch((err) => {
          if (!ctrl.signal.aborted) this.errors.set(sid, err.message || "Analysis failed.");
        })
        .finally(() => {
          if (this.active.get(sid) === ctrl) this.active.delete(sid);
          if (!this.stopped) {
            this.pump();
            this.onChange(sid);
          }
        });
    }
    this.onChange();
  }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export class Reader {
  /**
   * @param {object} deps
   * @param {(input: object, signal: AbortSignal) => Promise<object>} deps.analyze
   * @param {(scan: object) => void} deps.onAnalyzed called after an analysis is stored on the scan
   */
  constructor({ analyze, onAnalyzed }) {
    this.analyze = analyze;
    this.onAnalyzed = onAnalyzed;
    this.prefs = loadPrefs();
    this.scan = null;
    this.queue = null;
    this.current = null; // {sid, i}
    this.photoUrl = null;

    const $ = (id) => document.getElementById(id);
    this.el = {
      title: $("reader-title"),
      latin: $("latin"),
      aboutSource: $("about-source"),
      aboutText: $("about-text"),
      aboutNotes: $("about-notes"),
      about: $("about"),
      progress: $("analysis-progress"),
      bar: $("analysis-bar"),
      progressLabel: $("analysis-label"),
      retryFailed: $("btn-retry-failed"),
      photoPanel: $("photo-panel"),
      photo: $("reader-photo"),
      btnPhoto: $("btn-photo"),
      btnTranslation: $("btn-translation"),
      btnSize: $("btn-size"),
      sheet: $("sheet"),
      sheetHead: document.querySelector(".sheet-head"),
      sheetForm: $("sheet-form"),
      sheetLemma: $("sheet-lemma"),
      sheetBody: $("sheet-body"),
      btnPrev: $("btn-prev"),
      btnNext: $("btn-next"),
      btnClose: $("btn-close"),
      lightbox: $("lightbox"),
      lightboxImg: $("lightbox-img"),
      lightboxClose: $("btn-lightbox-close"),
      topbar: document.querySelector(".topbar"),
    };

    this.bindEvents();
    this.applyPrefs();
  }

  // --- lifecycle -----------------------------------------------------------

  open(scan) {
    this.close();
    this.scan = scan;
    const t = scan.transcription;

    this.el.title.textContent = scan.title || t.title || "Untitled page";
    document.title = `${this.el.title.textContent} · Translatinate`;
    this.el.aboutSource.textContent = t.source;
    this.el.aboutText.textContent = t.about;
    this.el.aboutNotes.textContent = t.notes;
    this.el.about.hidden = !(t.source || t.about || t.notes);

    if (scan.image) this.photoUrl = URL.createObjectURL(scan.image);
    const photoSrc = this.photoUrl || scan.imageUrl || "";
    for (const img of [this.el.photo, this.el.lightboxImg]) {
      if (photoSrc) img.src = photoSrc;
      else img.removeAttribute("src");
    }
    this.el.btnPhoto.hidden = !photoSrc;
    this.setPhotoVisible(false);

    this.render();

    const passage = passageOf(t);
    this.queue = new AnalysisQueue({
      // A sentence with no words (say, just "[…]") has nothing to analyze.
      sids: [...this.sentences.values()].filter((info) => info.words.length > 0).map((info) => info.sid),
      isDone: (sid) => Boolean(this.scan?.analyses[sid]),
      run: async (sid, signal) => {
        const info = this.sentences.get(sid);
        const scanAtStart = this.scan;
        const data = await this.analyze(
          { passage, sentence: info.text, translation: info.translation, words: info.words },
          signal,
        );
        if (this.scan !== scanAtStart) return;
        scanAtStart.analyses[sid] = data;
        this.onAnalyzed(scanAtStart);
      },
      onChange: (sid) => this.onQueueChange(sid),
    });
    this.queue.start();
  }

  close() {
    this.queue?.stop();
    this.queue = null;
    this.closeSheet();
    this.closeLightbox();
    if (this.photoUrl) URL.revokeObjectURL(this.photoUrl);
    this.photoUrl = null;
    this.scan = null;
    document.title = "Translatinate";
  }

  // --- rendering -------------------------------------------------------------

  render() {
    const { blocks } = this.scan.transcription;
    this.sentences = new Map(); // sid -> {sid, text, translation, words, wordEls, spans}
    this.order = []; // every word in reading order: {sid, i}

    const frag = document.createDocumentFragment();
    blocks.forEach((block, b) => {
      const verse = block.kind === "verse";
      const blockEl = h(block.kind === "heading" ? "h2" : verse ? "div" : "p", {
        class: `blk blk-${block.kind}`,
      });
      let line = verse ? blockEl.appendChild(h("div", { class: "vl" })) : blockEl;
      const newLine = () => {
        if (line.textContent.trim()) line = blockEl.appendChild(h("div", { class: "vl" }));
      };

      block.sentences.forEach((sentence, s) => {
        const sid = `${b}.${s}`;
        const info = {
          sid,
          text: sentence.text,
          translation: sentence.translation,
          words: [],
          wordEls: [],
          spans: [],
        };
        const newSpan = () => {
          const span = h("span", { class: "sent", "data-sid": sid });
          if (line.textContent && !/\s$/.test(line.textContent)) line.append(" ");
          line.append(span);
          info.spans.push(span);
          return span;
        };
        let span = newSpan();

        for (const part of tokenize(sentence.text)) {
          if (part.type === "br") {
            if (verse) {
              newLine();
              span = newSpan();
            } else {
              span.append(" ");
            }
          } else if (part.type === "word") {
            const w = h("span", { class: "w", "data-sid": sid, "data-i": part.i }, part.text);
            span.append(w);
            info.words.push(part.text);
            info.wordEls.push(w);
            this.order.push({ sid, i: part.i });
          } else {
            span.append(part.text);
          }
        }
        this.sentences.set(sid, info);
      });

      frag.append(blockEl);
      const translation = block.sentences.map((s) => s.translation).filter(Boolean).join(" ");
      if (translation) frag.append(h("p", { class: "trans", lang: "en" }, translation));
    });

    this.el.latin.replaceChildren(frag);
  }

  onQueueChange(sid) {
    if (!this.queue) return;
    const { done, total, failed } = this.queue.counts();
    this.el.progress.hidden = done === total;
    this.el.bar.style.width = `${total ? (done / total) * 100 : 100}%`;
    this.el.progressLabel.textContent =
      `Analyzing words… ${done}/${total} sentences` + (failed ? ` · ${failed} failed` : "");
    this.el.retryFailed.hidden = failed === 0;
    if (sid && this.current?.sid === sid) this.paintSelection({ scroll: false });
  }

  // --- selection & sheet ------------------------------------------------------

  /** The reader tapped (or stepped to) a word. */
  showWord(sid, i, { scroll = true } = {}) {
    if (!this.sentences?.get(sid)?.wordEls[i]) return;
    this.current = { sid, i };
    this.paintSelection({ scroll });
    this.queue?.prioritize(sid); // repaints via onQueueChange if the status changes
  }

  /** Draws the current selection: highlights in the text, and the sheet. */
  paintSelection({ scroll }) {
    const { sid, i } = this.current;
    const info = this.sentences.get(sid);
    const wordEl = info.wordEls[i];

    for (const el of this.el.latin.querySelectorAll(".sel, .linked, .ctx")) {
      el.classList.remove("sel", "linked", "ctx");
    }
    wordEl.classList.add("sel");
    for (const span of info.spans) span.classList.add("ctx");

    const analysis = this.scan.analyses[sid];
    const word = analysis?.words.find((w) => w.i === i);
    for (const j of word?.links ?? []) info.wordEls[j]?.classList.add("linked");

    this.renderSheet(info, i, analysis, word);
    this.openSheet();
    if (scroll) this.ensureVisible(wordEl);

    const pos = this.order.findIndex((w) => w.sid === sid && w.i === i);
    this.el.btnPrev.disabled = pos <= 0;
    this.el.btnNext.disabled = pos >= this.order.length - 1;
  }

  step(delta) {
    if (!this.current) return;
    const pos = this.order.findIndex((w) => w.sid === this.current.sid && w.i === this.current.i);
    const next = this.order[pos + delta];
    if (next) this.showWord(next.sid, next.i);
  }

  renderSheet(info, i, analysis, word) {
    this.el.sheetForm.textContent = info.words[i];
    this.el.sheetLemma.textContent = word?.lemma ?? "";

    const body = [];
    const status = this.queue?.status(info.sid) ?? "done";

    if (word) {
      body.push(
        word.pos && h("div", { class: "chips" }, h("span", { class: "chip chip-pos" }, word.pos)),
        word.parse && h("p", { class: "parse" }, word.parse),
        word.meaning_here &&
          h("div", { class: "field" }, h("span", { class: "field-label" }, "Here it means"), h("div", { class: "meaning" }, word.meaning_here)),
        word.role && h("div", { class: "field" }, h("span", { class: "field-label" }, "Role in the sentence"), word.role),
        word.definitions?.length > 0 &&
          h(
            "div",
            { class: "field" },
            h("span", { class: "field-label" }, "Dictionary"),
            h("ol", {}, word.definitions.map((d) => h("li", {}, d))),
          ),
        word.note && h("div", { class: "field note" }, word.note),
        word.derivatives?.length > 0 &&
          h(
            "div",
            { class: "field" },
            h("span", { class: "field-label" }, "English words from it"),
            h("div", { class: "derivs" }, word.derivatives.map((d) => h("span", { class: "chip" }, d))),
          ),
      );
    } else if (status === "error") {
      body.push(
        h("p", { class: "sheet-status error" }, `Couldn't analyze this sentence: ${this.queue.errors.get(info.sid)}`),
        h(
          "p",
          { class: "sheet-status" },
          h("button", { class: "btn btn-primary", type: "button", onclick: () => this.queue.prioritize(info.sid) }, "Try again"),
        ),
      );
    } else if (analysis) {
      body.push(h("p", { class: "sheet-status" }, "No analysis came back for this word."));
    } else {
      body.push(
        h("p", { class: "sheet-status" }, "Analyzing this sentence…"),
        h("div", { class: "skeleton" }),
        h("div", { class: "skeleton short" }),
        h("div", { class: "skeleton" }),
      );
    }

    // The sentence the word sits in, with its translation.
    const latin = h("p", { class: "sentence-latin", lang: "la" });
    for (const part of tokenize(info.text)) {
      if (part.type === "br") {
        if (latin.textContent) latin.append("\n"); // skip a break the sentence starts with
      } else if (part.type === "word" && part.i === i) latin.append(h("mark", {}, part.text));
      else latin.append(part.text);
    }
    body.push(
      h(
        "div",
        { class: "sentence-box" },
        h("span", { class: "field-label" }, "The sentence"),
        latin,
        info.translation && h("p", { class: "sentence-trans" }, info.translation),
        analysis &&
          (analysis.literal || analysis.structure) &&
          h(
            "details",
            {},
            h("summary", {}, "Word-for-word & structure"),
            analysis.literal && h("p", {}, h("strong", {}, "Literally: "), analysis.literal),
            analysis.structure && h("p", {}, analysis.structure),
          ),
      ),
    );

    // Keep the sentence-details expander open while stepping through words.
    const wasOpen = this.el.sheetBody.querySelector("details")?.open;
    this.el.sheetBody.replaceChildren(...body.filter(Boolean));
    if (wasOpen) {
      const details = this.el.sheetBody.querySelector("details");
      if (details) details.open = true;
    }
    this.el.sheetBody.scrollTop = 0;
  }

  openSheet() {
    const { sheet } = this.el;
    if (!sheet.classList.contains("open")) {
      sheet.classList.add("open");
      sheet.setAttribute("aria-hidden", "false");
    }
    this.syncSheetHeight();
  }

  closeSheet() {
    const { sheet } = this.el;
    sheet.classList.remove("open");
    sheet.style.transform = "";
    sheet.setAttribute("aria-hidden", "true");
    for (const el of this.el.latin.querySelectorAll(".sel, .linked, .ctx")) {
      el.classList.remove("sel", "linked", "ctx");
    }
    this.current = null;
    document.documentElement.style.setProperty("--sheet-height", "0px");
  }

  syncSheetHeight() {
    if (!this.el.sheet.classList.contains("open")) return;
    document.documentElement.style.setProperty("--sheet-height", `${this.el.sheet.offsetHeight}px`);
  }

  ensureVisible(el) {
    const rect = el.getBoundingClientRect();
    const top = this.el.topbar.getBoundingClientRect().bottom + 12;
    const bottom = window.innerHeight - this.el.sheet.offsetHeight - 16;
    if (rect.top < top) window.scrollBy({ top: rect.top - top - 40, behavior: "smooth" });
    else if (rect.bottom > bottom) window.scrollBy({ top: rect.bottom - bottom + 40, behavior: "smooth" });
  }

  // --- toggles ----------------------------------------------------------------

  applyPrefs() {
    const size = TEXT_SIZES[this.prefs.size] ?? TEXT_SIZES[2];
    document.documentElement.style.setProperty("--text-size", `${size}px`);
    this.el.latin.classList.toggle("show-trans", this.prefs.translation);
    this.el.btnTranslation.setAttribute("aria-pressed", String(this.prefs.translation));
  }

  setPhotoVisible(visible) {
    this.el.photoPanel.hidden = !visible;
    this.el.btnPhoto.setAttribute("aria-pressed", String(visible));
  }

  closeLightbox() {
    this.el.lightbox.hidden = true;
    this.el.lightbox.classList.remove("zoomed");
  }

  // --- events -----------------------------------------------------------------

  bindEvents() {
    const { el } = this;

    el.latin.addEventListener("click", (event) => {
      const word = event.target.closest(".w");
      if (word) this.showWord(word.dataset.sid, Number(word.dataset.i));
      else this.closeSheet();
    });

    el.btnPrev.addEventListener("click", () => this.step(-1));
    el.btnNext.addEventListener("click", () => this.step(1));
    el.btnClose.addEventListener("click", () => this.closeSheet());
    el.retryFailed.addEventListener("click", () => this.queue?.retryFailed());

    el.btnTranslation.addEventListener("click", () => {
      this.prefs.translation = !this.prefs.translation;
      savePrefs(this.prefs);
      this.applyPrefs();
    });
    el.btnSize.addEventListener("click", () => {
      this.prefs.size = (this.prefs.size + 1) % TEXT_SIZES.length;
      savePrefs(this.prefs);
      this.applyPrefs();
    });
    el.btnPhoto.addEventListener("click", () => {
      this.setPhotoVisible(el.photoPanel.hidden);
      if (!el.photoPanel.hidden) window.scrollTo({ top: 0, behavior: "smooth" });
    });

    el.photo.addEventListener("click", () => {
      el.lightbox.hidden = false;
    });
    el.lightboxImg.addEventListener("click", () => el.lightbox.classList.toggle("zoomed"));
    el.lightboxClose.addEventListener("click", () => this.closeLightbox());

    document.addEventListener("keydown", (event) => {
      if (!this.scan || event.target.closest?.("input, textarea, dialog")) return;
      if (event.key === "Escape") {
        if (!el.lightbox.hidden) this.closeLightbox();
        else this.closeSheet();
      } else if (this.current && event.key === "ArrowRight") {
        event.preventDefault();
        this.step(1);
      } else if (this.current && event.key === "ArrowLeft") {
        event.preventDefault();
        this.step(-1);
      }
    });

    new ResizeObserver(() => this.syncSheetHeight()).observe(el.sheet);

    // Drag the sheet's header down to dismiss it.
    let startY = null;
    let dy = 0;
    el.sheetHead.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      startY = event.clientY;
      dy = 0;
      el.sheet.classList.add("dragging");
      el.sheetHead.setPointerCapture(event.pointerId);
    });
    el.sheetHead.addEventListener("pointermove", (event) => {
      if (startY === null) return;
      dy = Math.max(0, event.clientY - startY);
      el.sheet.style.transform = `translateY(${dy}px)`;
    });
    const endDrag = () => {
      if (startY === null) return;
      startY = null;
      el.sheet.classList.remove("dragging");
      el.sheet.style.transform = "";
      if (dy > 80) this.closeSheet();
    };
    el.sheetHead.addEventListener("pointerup", endDrag);
    el.sheetHead.addEventListener("pointercancel", endDrag);
  }
}

