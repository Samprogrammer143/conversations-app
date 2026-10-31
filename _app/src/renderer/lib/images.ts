// Images for a message. The API takes up to 5 MB per image, counted as base64, which is
// about 3.75 MB of file: a bigger one (most full-screen screenshots) is made smaller here,
// keeping text readable, rather than refused.

export const MAX_BASE64 = 5 * 1024 * 1024;
const MAX_FILE = Math.floor((MAX_BASE64 * 3) / 4) - 1024;

/** What to try, in order, until one fits: sharpest first. Longest side in pixels (Infinity: as it is), and quality. */
export const SHRINK_STEPS: readonly [number, number][] = [
  [Infinity, 0.92],
  [Infinity, 0.82],
  [2800, 0.85],
  [2200, 0.85],
  [1800, 0.8],
  [1400, 0.75],
  [1000, 0.7],
];

/** The drawn size for a longest side, never larger than the image. */
export function fitSize(width: number, height: number, longest: number): { width: number; height: number } {
  const scale = Math.min(1, longest / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const encode = (canvas: HTMLCanvasElement, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));

export const toBase64 = (blob: Blob) =>
  new Promise<string | null>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? null);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });

export function fromBase64(data: string, type: string): Blob {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** An image that fits: the file as it is when it already does, otherwise a smaller WebP. Null when it can't be read. */
export async function fitImage(blob: Blob, mediaType: string): Promise<{ mediaType: string; data: string; shrunk: boolean } | null> {
  if (blob.size <= MAX_FILE) {
    const data = await toBase64(blob);
    return data ? { mediaType, data, shrunk: false } : null;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    for (const [longest, quality] of SHRINK_STEPS) {
      const size = fitSize(bitmap.width, bitmap.height, longest);
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, size.width, size.height);
      const out = await encode(canvas, quality);
      if (out && out.type === "image/webp" && out.size <= MAX_FILE) {
        const data = await toBase64(out);
        return data ? { mediaType: "image/webp", data, shrunk: true } : null;
      }
    }
    return null;
  } finally {
    bitmap.close();
  }
}
