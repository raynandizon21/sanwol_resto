/**
 * Turn SDK / fetch / Gemini JSON errors into short messages for RestoAdmin UI (receipt scan modals, etc.).
 */

function messageFromUnknown(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

function parseNestedError(text: string): { code?: number; status?: string; message?: string } {
    const out: { code?: number; status?: string; message?: string } = {};
    const tryParse = (slice: string) => {
        try {
            const o = JSON.parse(slice) as Record<string, unknown>;
            const e = (o?.error as Record<string, unknown> | undefined) ?? o;
            if (e && typeof e === 'object') {
                if (typeof e.code === 'number') out.code = e.code;
                if (typeof e.status === 'string') out.status = e.status;
                if (typeof e.message === 'string') out.message = e.message;
            }
        } catch {
            /* ignore */
        }
    };

    const trimmed = text.trim();
    if (trimmed.startsWith('{')) tryParse(trimmed);

    const idx = text.indexOf('{');
    if (idx >= 0 && idx !== 0) tryParse(text.slice(idx));

    if (out.code == null) {
        const codeM = text.match(/"code"\s*:\s*(\d+)/);
        if (codeM) out.code = Number(codeM[1]);
    }
    if (!out.status) {
        const statusM = text.match(/"status"\s*:\s*"([^"]+)"/);
        if (statusM) out.status = statusM[1];
    }
    return out;
}

/**
 * Maps HTTP-style codes, Gemini `RESOURCE_EXHAUSTED`, and auth strings to readable copy.
 */
export function toUserFriendlyError(err: unknown): string {
    const text = messageFromUnknown(err);
    const lower = text.toLowerCase();
    const { code, status, message: nestedMsg } = parseNestedError(text);
    const blob = `${text}\n${nestedMsg ?? ''}`.toLowerCase();

    const isExpiredToken =
        code === 401 ||
        /\b401\b/.test(text) ||
        lower.includes('unauthorized') ||
        lower.includes('jwt expired') ||
        lower.includes('token expired') ||
        lower.includes('expired token') ||
        lower.includes('invalid_grant') ||
        lower.includes('invalid token') ||
        blob.includes('invalid jwt') ||
        (lower.includes('authentication') &&
            (lower.includes('invalid') || lower.includes('failed') || lower.includes('credential')));

    if (isExpiredToken) {
        return 'Token was expired. Please contact your administrator.';
    }

    if (code === 403 || lower.includes('forbidden') || lower.includes('permission denied')) {
        return 'Access was denied. Please contact your administrator.';
    }

    if (
        blob.includes('api key') &&
        (blob.includes('invalid') || blob.includes('not valid') || blob.includes('expired'))
    ) {
        return 'The AI key is missing or not valid. Please contact your administrator.';
    }

    const isQuotaOrRate =
        code === 429 ||
        status === 'RESOURCE_EXHAUSTED' ||
        lower.includes('resource_exhausted') ||
        lower.includes('quota') ||
        lower.includes('rate limit') ||
        lower.includes('too many requests');

    if (isQuotaOrRate) {
        return 'The AI service limit was reached or the service is busy. Please wait a short time and try again, or contact your administrator.';
    }

    if (code === 503 || code === 502 || lower.includes('unavailable') || lower.includes('bad gateway')) {
        return 'The service is temporarily unavailable. Please try again in a moment.';
    }

    if (code === 504 || lower.includes('timeout') || lower.includes('deadline exceeded')) {
        return 'The request took too long. Please try again.';
    }

    if (code === 400 || lower.includes('invalid_argument') || lower.includes('bad request')) {
        return 'The request could not be processed. Please try again or use a clearer receipt photo.';
    }

    if (lower.includes('resto_admin_api_url') && lower.includes('missing')) {
        return 'RESTO_ADMIN_API_URL is missing in .env.';
    }

    if (
        lower.includes('failed to fetch') ||
        lower.includes('networkerror') ||
        lower.includes('network request failed') ||
        lower.includes('load failed')
    ) {
        return 'Could not reach the server. Check your connection and try again.';
    }

    const looksLikeApiJson =
        (text.includes('{') && text.includes('"error"')) || text.length > 400;

    if (looksLikeApiJson) {
        return 'Something went wrong. Please try again or contact your administrator.';
    }

    return text.trim() || 'Something went wrong. Please try again.';
}
