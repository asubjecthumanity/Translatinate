import * as api from "./api.js";
import { preparePhoto } from "./image.js";
import { Reader } from "./reader.js";
import * as store from "./store.js";

const $ = (id) => document.getElementById(id);

const views = {
  home: $("view-home"),
  processing: $("view-processing"),
  reader: $("view-reader"),
};

/** Scans not (yet) in IndexedDB: the sample, or pages that failed to save. */
const memoryScans = new Map();
let processing = null; // AbortController for the photo being transcribed
let lastInput = $("camera-input");
let libraryUrls = [];
let processingPhotoUrl = null;

function setProcessingPhoto(blob) {
  if (processingPhotoUrl) URL.revokeObjectURL(processingPhotoUrl);
  processingPhotoUrl = URL.createObjectURL(blob);
  $("processing-photo").src = processingPhotoUrl;
}

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

function newId() {
  // crypto.randomUUID needs HTTPS, and this also runs over plain LAN http.
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------------------
// Passcode: ask once (even if several requests hit a 401 together), remember it.
// ---------------------------------------------------------------------------

let passcodePrompt = null;

function askPasscode(showError) {
  passcodePrompt ??= new Promise((resolve) => {
    const dialog = $("passcode-dialog");
    const input = $("passcode-input");
    $("passcode-error").hidden = !showError;
    input.value = "";
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "ok" && input.value ? input.value : null),
      { once: true },
    );
    dialog.showModal();
  }).finally(() => (passcodePrompt = null));
  return passcodePrompt;
}

async function withPasscode(request) {
  let attempts = 0;
  for (;;) {
    try {
      return await request();
    } catch (err) {
      if (!(err instanceof api.PasscodeError)) throw err;
      const code = await askPasscode(attempts > 0);
      if (code === null) throw new Error("This server needs a passcode.");
      api.savePasscode(code);
      attempts++;
    }
  }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

const saveTimers = new Map();
function saveSoon(scan) {
  if (scan.sample) return;
  clearTimeout(saveTimers.get(scan.id));
  saveTimers.set(
    scan.id,
    setTimeout(() => {
      saveTimers.delete(scan.id);
      store.saveScan(scan).catch(() => {});
    }, 400),
  );
}

const reader = new Reader({
  analyze: (input, signal) => withPasscode(() => api.analyze(input, { signal })),
  onAnalyzed: saveSoon,
});

async function openScan(id) {
  let scan = memoryScans.get(id);
  if (!scan) {
    try {
      scan = await store.getScan(id);
    } catch {
      // fall through to "not found"
    }
  }
  if (!scan) {
    toast("That page isn't in your library any more.");
    location.replace("#/");
    return;
  }
  showView("reader");
  reader.open(scan);
}

async function openSample() {
  try {
    const res = await fetch("/sample/sample.json");
    const sample = await res.json();
    const scan = {
      id: "sample",
      sample: true,
      title: sample.transcription.title,
      imageUrl: "/sample/page.jpg",
      transcription: sample.transcription,
      analyses: structuredClone(sample.analyses),
    };
    showView("reader");
    reader.open(scan);
  } catch {
    toast("Couldn't load the sample.");
    location.replace("#/");
  }
}

// ---------------------------------------------------------------------------
// Taking a photo → transcription
// ---------------------------------------------------------------------------

/** Pulls the Latin sentences out of the partial JSON streamed so far. */
function previewText(json) {
  const out = [];
  for (const match of json.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)/g)) {
    const raw = match[1].replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, "");
    try {
      out.push(JSON.parse(`"${raw}"`));
    } catch {
      out.push(raw);
    }
  }
  return out.join(" ").replace(/\s+/g, " ");
}

function setProcessingStatus(text) {
  $("processing-status").textContent = text;
}

function renderPreview(json) {
  const el = $("processing-preview");
  const text = previewText(json);
  if (!text) {
    el.replaceChildren();
    return;
  }
  const cursor = document.createElement("span");
  cursor.className = "cursor";
  const p = document.createElement("p");
  p.lang = "la";
  p.append(text.slice(-700), cursor);
  el.replaceChildren(p);
}

function failProcessing(message) {
  document.querySelector(".processing").classList.add("failed");
  setProcessingStatus("Something went wrong");
  $("processing-error-text").textContent = message;
  $("processing-error").hidden = false;
  $("btn-cancel").textContent = "Back";
}

async function handleFile(file) {
  processing?.abort();
  const ctrl = new AbortController();
  processing = ctrl;

  document.querySelector(".processing").classList.remove("failed");
  $("processing-error").hidden = true;
  $("btn-cancel").textContent = "Cancel";
  $("processing-preview").replaceChildren();
  setProcessingStatus("Preparing photo…");
  setProcessingPhoto(file);
  location.hash = "#/scanning";

  try {
    const photo = await preparePhoto(file);
    if (ctrl.signal.aborted) return;
    setProcessingPhoto(photo.blob);

    setProcessingStatus("Reading the page…");
    let json = "";
    const transcription = await withPasscode(() => {
      json = "";
      return api.transcribe(
        { image: photo.base64, mediaType: photo.mediaType },
        {
          signal: ctrl.signal,
          onReset: () => {
            json = "";
            renderPreview(json);
          },
          onText: (delta) => {
            json += delta;
            setProcessingStatus("Transcribing…");
            renderPreview(json);
          },
        },
      );
    });
    if (ctrl.signal.aborted) return;

    if (!transcription.readable) {
      failProcessing(
        "I couldn't find Latin text to read in this photo." +
          (transcription.notes ? `\n\n${transcription.notes}` : ""),
      );
      return;
    }

    const scan = {
      id: newId(),
      createdAt: Date.now(),
      title: transcription.title || "Untitled page",
      image: photo.blob,
      thumb: photo.thumb,
      transcription,
      analyses: {},
    };
    try {
      await store.saveScan(scan);
    } catch {
      memoryScans.set(scan.id, scan);
      toast("Couldn't save this page to your library on this device.");
    }
    processing = null;
    location.replace(`#/scan/${scan.id}`);
  } catch (err) {
    if (ctrl.signal.aborted || err.name === "AbortError") return;
    failProcessing(err.message || "Something went wrong.");
  }
}

// ---------------------------------------------------------------------------
// Home / library
// ---------------------------------------------------------------------------

function formatDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

async function renderLibrary() {
  for (const url of libraryUrls) URL.revokeObjectURL(url);
  libraryUrls = [];

  let scans = [];
  try {
    scans = await store.listScans();
  } catch {
    // IndexedDB unavailable; show nothing.
  }
  scans.push(...[...memoryScans.values()].filter((s) => !scans.some((x) => x.id === s.id)));

  const items = scans.map((scan) => {
    const sentences = scan.transcription.blocks.reduce((n, b) => n + b.sentences.length, 0);
    const analyzed = Object.keys(scan.analyses || {}).length;

    const li = document.createElement("li");
    li.className = "library-item";

    const link = document.createElement("a");
    link.href = `#/scan/${scan.id}`;
    const img = document.createElement("img");
    img.className = "library-thumb";
    img.alt = "";
    if (scan.thumb) {
      const url = URL.createObjectURL(scan.thumb);
      libraryUrls.push(url);
      img.src = url;
    }
    const meta = document.createElement("div");
    meta.className = "library-meta";
    const title = document.createElement("div");
    title.className = "library-title";
    title.lang = "la";
    title.textContent = scan.title;
    const sub = document.createElement("div");
    sub.className = "library-sub";
    sub.textContent =
      `${formatDate(scan.createdAt)} · ${sentences} sentence${sentences === 1 ? "" : "s"}` +
      (analyzed < sentences ? ` · ${analyzed} analyzed` : "");
    meta.append(title, sub);
    link.append(img, meta);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn";
    del.setAttribute("aria-label", `Delete ${scan.title}`);
    del.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';
    del.addEventListener("click", async () => {
      if (!confirm(`Delete “${scan.title}” from your library?`)) return;
      memoryScans.delete(scan.id);
      await store.deleteScan(scan.id).catch(() => {});
      renderLibrary();
    });

    li.append(link, del);
    return li;
  });

  $("library-list").replaceChildren(...items);
  $("library-empty").hidden = items.length > 0;
}

// ---------------------------------------------------------------------------
// Routing: #/  ·  #/scanning  ·  #/scan/<id>  ·  #/sample
// ---------------------------------------------------------------------------

function route() {
  const hash = location.hash || "#/";

  if (hash !== "#/scanning" && processing) {
    processing.abort(); // back button while a photo is being read
    processing = null;
  }
  if (!hash.startsWith("#/scan/") && hash !== "#/sample") reader.close();

  if (hash === "#/scanning") {
    if (processing) showView("processing");
    else location.replace("#/");
  } else if (hash.startsWith("#/scan/")) {
    openScan(decodeURIComponent(hash.slice("#/scan/".length)));
  } else if (hash === "#/sample") {
    openSample();
  } else {
    showView("home");
    renderLibrary();
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

for (const input of [$("camera-input"), $("library-input")]) {
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = ""; // allow picking the same file again
    if (file) handleFile(file);
  });
}

$("btn-camera").addEventListener("click", () => {
  lastInput = $("camera-input");
  lastInput.click();
});
$("btn-library").addEventListener("click", () => {
  lastInput = $("library-input");
  lastInput.click();
});
$("btn-retry-photo").addEventListener("click", () => lastInput.click());
$("btn-cancel").addEventListener("click", () => {
  processing?.abort();
  processing = null;
  location.hash = "#/";
});

window.addEventListener("hashchange", route);

api.getConfig().then((config) => {
  $("demo-badge").hidden = !config.mock;
});

route();
