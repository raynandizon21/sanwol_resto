const authHeaders = (): Record<string, string> => {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

export type ReceiptExpenseItem = {
  qty: number;
  name: string;
  price: number;
  category: string;
  unit?: string;
};

export type ReceiptExpenseExtractionResult = {
  items: ReceiptExpenseItem[];
  receipt_grand_total: number;
  extracted_items_sum: number;
  math_match: boolean;
};

export async function extractExpenseItemsFromReceiptImage(params: {
  imageDataUrl: string;
  /** Kept for backwards compatibility; server-side analyzer does not need this. */
  apiKey?: string;
  categories: string[];
}): Promise<ReceiptExpenseExtractionResult> {
  const base64 = String(params.imageDataUrl ?? '').trim();
  if (!base64) throw new Error('Invalid image data');

  // Use backend Vertex AI analyzer (prevents Gemini 429 client-side).
  const res = await fetch(`${window.location.origin}/data-api/api/receiptscanner/analyze`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({ base64, categories: params.categories }),
  });

  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: ReceiptExpenseExtractionResult;
    error?: string;
  };
  if (!res.ok || !json.success || !json.data) {
    const serverMsg = (json.error || '').trim() || 'Failed to analyze receipt';
    if (res.status === 422) {
      throw new Error(
        `${serverMsg} Very long receipts can exceed the scanner output limit—try scanning the receipt in two or more shorter sections (split the image or capture top and bottom separately), then add the items together.`
      );
    }
    throw new Error(serverMsg);
  }
  return json.data;
}

