import React from 'react';

import { cn } from '../../lib/utils';

/**
 * "Powered by Core System" credit on the login page, using the Core System wordmark image.
 *
 * The wordmark is sized in em so its lettering matches the "Powered by" label: measured on the image,
 * capitals (the "C") span 31% of its height, while Noto Sans capitals are 0.714em. It is set inline and
 * lowered so its text baseline (8.8% above the image bottom, below is the "y" descender) lines up with
 * the label's baseline. The triangles above the capitals (60% of the height) are pulled out of the line
 * height, so they don't push the label down.
 */
const LABEL_CAP_HEIGHT_EM = 0.714; // Noto Sans
const WORDMARK = { capOfHeight: 0.31, baselineFromBottom: 0.088, aboveCapOfHeight: 0.6 };
const MARK_HEIGHT_EM = LABEL_CAP_HEIGHT_EM / WORDMARK.capOfHeight; // ≈ 2.3em

const em = (n: number) => `${n.toFixed(3)}em`;

// markScale > 1 makes "Core System" larger than the "Powered by" label (1 = same letter height).
const SIZES = {
  lg: { text: 'text-sm', markScale: 1.4 },
} as const;

export const PoweredByCoreSystem: React.FC<{ size?: keyof typeof SIZES; className?: string }> = ({
  size = 'lg',
  className,
}) => {
  const s = SIZES[size];
  const markHeight = MARK_HEIGHT_EM * s.markScale;
  return (
    <div className={cn('leading-none whitespace-nowrap', s.text, className)}>
      <span className="text-brand-muted">Powered by</span>
      <img
        src="/core-system-wordmark.png"
        alt="Core System"
        className="inline-block w-auto ml-[0.4em]"
        style={{
          height: em(markHeight),
          verticalAlign: em(-markHeight * WORDMARK.baselineFromBottom),
          marginTop: em(-markHeight * WORDMARK.aboveCapOfHeight),
        }}
      />
    </div>
  );
};
