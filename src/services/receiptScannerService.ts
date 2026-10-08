/** Receipt image prep + Gemini key (same source as ReceiptLens: DB or local env). */

const MAX_IMAGE_DIM = 1536;
const JPEG_QUALITY = 0.88;

const authHeaders = (): Record<string, string> => {
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
};

export function compressReceiptImage(dataUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            const w = img.naturalWidth;
            const h = img.naturalHeight;
            let dw = w;
            let dh = h;
            if (w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM) {
                if (w >= h) {
                    dw = MAX_IMAGE_DIM;
                    dh = Math.round((h * MAX_IMAGE_DIM) / w);
                } else {
                    dh = MAX_IMAGE_DIM;
                    dw = Math.round((w * MAX_IMAGE_DIM) / h);
                }
            }
            const canvas = document.createElement('canvas');
            canvas.width = dw;
            canvas.height = dh;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                resolve(dataUrl);
                return;
            }
            ctx.drawImage(img, 0, 0, dw, dh);
            try {
                resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
            } catch {
                resolve(dataUrl);
            }
        };
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = dataUrl;
    });
}

/**
 * Gemini key: Vite `define` injects `process.env.GEMINI_API_KEY` for local dev;
 * otherwise GET /api/receiptscanner/gemini-key (optional auth).
 */
export async function fetchReceiptScannerGeminiKey(): Promise<string> {
    try {
        const envKey = (typeof process !== 'undefined' && (process as { env?: { GEMINI_API_KEY?: string } }).env?.GEMINI_API_KEY) || '';
        const localKey = String(envKey).trim();
        const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
        if (isLocalhost && localKey) return localKey;

        const res = await fetch(`${window.location.origin}/data-api/api/receiptscanner/gemini-key`, {
            credentials: 'include',
            headers: authHeaders(),
        });
        const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: { apiKey?: string }; error?: string };
        if (!res.ok || !json.success || !json.data?.apiKey) {
            if (localKey) return localKey;
            throw new Error(json.error || 'Failed to load receipt scanner API key');
        }
        return String(json.data.apiKey).trim();
    } catch (e) {
        const envKey = (typeof process !== 'undefined' && (process as { env?: { GEMINI_API_KEY?: string } }).env?.GEMINI_API_KEY) || '';
        const localKey = String(envKey).trim();
        if (localKey) return localKey;
        throw e instanceof Error ? e : new Error('Failed to load receipt scanner API key');
    }
}

export async function stitchReceiptImages(images: string[], options?: { maxWidth?: number; maxHeight?: number; quality?: number }): Promise<string> {
    if (!Array.isArray(images) || images.length === 0) {
        throw new Error('No images to stitch');
    }
    const res = await fetch(`${window.location.origin}/data-api/api/receiptscanner/stitch`, {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
        },
        body: JSON.stringify({
            images,
            maxWidth: options?.maxWidth,
            maxHeight: options?.maxHeight,
            quality: options?.quality,
        }),
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: { image?: string }; error?: string };
    if (!res.ok || !json.success || !json.data?.image) {
        throw new Error(json.error || 'Failed to stitch receipt images');
    }
    return String(json.data.image);
}
