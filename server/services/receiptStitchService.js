const sharp = require('sharp');

function parseDataUrl(input) {
  if (typeof input !== 'string') return null;
  const m = input.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  return { mime: m[1], base64: m[2] };
}

function estimateOverlapRows(prevGray, currGray, width) {
  const prevRows = Math.floor(prevGray.length / width);
  const currRows = Math.floor(currGray.length / width);
  if (prevRows < 40 || currRows < 40) return 0;

  const maxOverlap = Math.min(220, prevRows - 1, currRows - 1);
  const minOverlap = 40;
  let best = { overlap: 0, score: Number.POSITIVE_INFINITY };

  for (let overlap = minOverlap; overlap <= maxOverlap; overlap += 4) {
    let sum = 0;
    let n = 0;
    const prevStartRow = prevRows - overlap;
    for (let y = 0; y < overlap; y += 2) {
      const prevRow = (prevStartRow + y) * width;
      const currRow = y * width;
      for (let x = 0; x < width; x += 3) {
        sum += Math.abs(prevGray[prevRow + x] - currGray[currRow + x]);
        n += 1;
      }
    }
    if (!n) continue;
    const score = sum / n;
    if (score < best.score) {
      best = { overlap, score };
    }
  }

  // Guardrail: only apply overlap trim when strips are actually similar.
  if (best.score <= 18) return best.overlap;
  return 0;
}

async function toNormalizedSegment(dataUrl, targetWidth, quality) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) throw new Error('Invalid data URL');
  const inputBuffer = Buffer.from(parsed.base64, 'base64');

  const rotated = sharp(inputBuffer).rotate();
  const resized = await rotated
    .resize({
      width: targetWidth,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality, chromaSubsampling: '4:4:4' })
    .toBuffer();

  const meta = await sharp(resized).metadata();
  if (!meta.width || !meta.height) throw new Error('Image metadata unavailable');

  const gray = await sharp(resized).greyscale().raw().toBuffer();
  return {
    buffer: resized,
    width: meta.width,
    height: meta.height,
    gray,
  };
}

async function stitchReceiptDataUrls(dataUrls, options = {}) {
  if (!Array.isArray(dataUrls) || dataUrls.length === 0) {
    throw new Error('No images to stitch');
  }
  if (dataUrls.length > 12) {
    throw new Error('Too many images (max 12)');
  }

  const maxWidth = Math.max(640, Number(options.maxWidth) || 1400);
  const maxHeight = Math.max(1024, Number(options.maxHeight) || 8192);
  const quality = Math.min(95, Math.max(70, Number(options.quality) || 90));

  // First pass: inspect widths to pick consistent target.
  const metas = await Promise.all(
    dataUrls.map(async (u) => {
      const parsed = parseDataUrl(u);
      if (!parsed) throw new Error('Invalid image input');
      const b = Buffer.from(parsed.base64, 'base64');
      const m = await sharp(b).rotate().metadata();
      return { width: m.width || 0 };
    })
  );
  const widest = Math.max(...metas.map((m) => m.width || 0), 0);
  const targetWidth = Math.min(maxWidth, Math.max(600, widest || 1200));

  const segments = [];
  for (const url of dataUrls) {
    segments.push(await toNormalizedSegment(url, targetWidth, quality));
  }

  // Estimate overlap between adjacent shots and trim duplicated top rows.
  const trims = new Array(segments.length).fill(0);
  for (let i = 1; i < segments.length; i += 1) {
    const prev = segments[i - 1];
    const curr = segments[i];
    trims[i] = estimateOverlapRows(prev.gray, curr.gray, curr.width);
  }

  const composites = [];
  let y = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const trimTop = Math.min(Math.max(0, trims[i]), seg.height - 1);
    const outHeight = seg.height - trimTop;
    const input =
      trimTop > 0
        ? await sharp(seg.buffer)
            .extract({ left: 0, top: trimTop, width: seg.width, height: outHeight })
            .toBuffer()
        : seg.buffer;
    composites.push({
      input,
      left: 0,
      top: y,
    });
    y += outHeight;
  }

  if (y > maxHeight) {
    const scale = maxHeight / y;
    const scaledInputs = [];
    let scaledY = 0;
    for (const layer of composites) {
      const m = await sharp(layer.input).metadata();
      const w = Math.max(1, Math.round((m.width || targetWidth) * scale));
      const h = Math.max(1, Math.round((m.height || 1) * scale));
      const scaled = await sharp(layer.input).resize({ width: w, height: h }).toBuffer();
      scaledInputs.push({ input: scaled, left: 0, top: scaledY });
      scaledY += h;
    }
    const final = await sharp({
      create: {
        width: Math.max(1, Math.round(targetWidth * scale)),
        height: scaledY,
        channels: 3,
        background: '#ffffff',
      },
    })
      .composite(scaledInputs)
      .jpeg({ quality })
      .toBuffer();
    return `data:image/jpeg;base64,${final.toString('base64')}`;
  }

  const stitched = await sharp({
    create: {
      width: targetWidth,
      height: y,
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite(composites)
    .jpeg({ quality })
    .toBuffer();

  return `data:image/jpeg;base64,${stitched.toString('base64')}`;
}

module.exports = {
  stitchReceiptDataUrls,
};
