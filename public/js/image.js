// Shrinks a phone photo before upload. Claude reads images up to 2576 px on
// the long edge, and accepts at most 5 MB, so anything bigger is wasted bytes.
// The byte cap also keeps the base64 upload under Vercel's 4.5 MB request limit.

const MAX_EDGE = 2576;
const MAX_BYTES = 3 * 1024 * 1024;
const THUMB_EDGE = 240;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img); // browsers apply EXIF rotation when drawing
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file couldn't be opened as an image."));
    };
    img.src = url;
  });
}

function draw(img, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // transparent PNGs would otherwise turn black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toJpeg(canvas, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Couldn't compress the photo."))),
      "image/jpeg",
      quality,
    ),
  );
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * @param {File} file
 * @returns {Promise<{blob: Blob, thumb: Blob, base64: string, mediaType: string}>}
 */
export async function preparePhoto(file) {
  const img = await loadImage(file);
  try {
    let edge = MAX_EDGE;
    let blob;
    for (;;) {
      const canvas = draw(img, edge);
      for (const quality of [0.88, 0.78, 0.66]) {
        blob = await toJpeg(canvas, quality);
        if (blob.size <= MAX_BYTES) break;
      }
      if (blob.size <= MAX_BYTES || edge < 1200) break;
      edge = Math.round(edge * 0.8);
    }
    const thumb = await toJpeg(draw(img, THUMB_EDGE), 0.75);
    return { blob, thumb, base64: await blobToBase64(blob), mediaType: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(img.src);
  }
}
