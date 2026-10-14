// Client-side JPEG recompression. Scales the longest side to 1280px and
// re-encodes at quality 0.75; drops to 0.55 if still over target. Keeps the
// upload payload small so the Worker's inline-vs-R2 cutoff lands correctly
// and the DB blob stays bounded.

export async function compressImage(file, {
  maxDim = 1280,
  quality = 0.75,
  maxBytes = 500 * 1024
} = {}) {
  if (!file || !file.type || !file.type.startsWith("image/")) return file;
  if (file.size <= maxBytes) return file;

  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);

    let out = await new Promise(res => canvas.toBlob(res, "image/jpeg", quality));
    if (!out) return file;

    if (out.size > maxBytes) {
      const retry = await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.55));
      if (retry && retry.size < out.size) out = retry;
    }

    return new File(
      [out],
      (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg",
      { type: "image/jpeg", lastModified: Date.now() }
    );
  } catch (e) {
    console.warn("Image compression failed, uploading original:", e);
    return file;
  }
}
