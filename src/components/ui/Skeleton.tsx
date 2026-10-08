import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

const shimmerClass = 'skeleton-shimmer';

export interface SkeletonTransitionProps {
  /** When true, skeleton is shown. Hides as soon as loading becomes false. */
  loading: boolean;
  /** Optional fade-out when loading completes (ms). Default 0 = instant. */
  fadeOutMs?: number;
  /** Skeleton content to show while loading. */
  skeleton: React.ReactNode;
  /** Content to show after skeleton hides. */
  children: React.ReactNode;
  /** Optional wrapper class for the skeleton container (e.g. for positioning). */
  className?: string;
}

/**
 * Shows skeleton only while `loading` is true — no artificial minimum display time.
 */
export const SkeletonTransition: React.FC<SkeletonTransitionProps> = ({
  loading,
  fadeOutMs = 0,
  skeleton,
  children,
  className = '',
}) => {
  const { t } = useTranslation();
  const [showSkeleton, setShowSkeleton] = useState(loading);
  const [fadeOut, setFadeOut] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (loading) {
      setShowSkeleton(true);
      setFadeOut(false);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      return;
    }

    if (!showSkeleton) return;

    if (fadeOutMs <= 0) {
      setShowSkeleton(false);
      return;
    }

    setFadeOut(true);
    fadeTimerRef.current = setTimeout(() => {
      fadeTimerRef.current = null;
      setShowSkeleton(false);
    }, fadeOutMs);

    return () => {
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, [fadeOutMs, loading, showSkeleton]);

  if (!showSkeleton) {
    return <>{children}</>;
  }

  return (
    <div
      className={`skeleton-transition-wrapper ${fadeOut ? 'skeleton-fade-out' : ''} ${className}`.trim()}
      style={fadeOutMs > 0 ? { transition: `opacity ${fadeOutMs}ms ease-out` } : undefined}
      aria-busy={loading}
      aria-live="polite"
      aria-label={loading ? t('common.loading') : undefined}
    >
      {skeleton}
    </div>
  );
};

export interface SkeletonProps {
  className?: string;
  style?: React.CSSProperties;
}

/** Base skeleton block with shimmer. Use className for size (e.g. w-full h-4, rounded-lg). */
export const Skeleton: React.FC<SkeletonProps> = ({ className = '', style }) => (
  <div
    role="presentation"
    aria-hidden
    className={`bg-slate-200 overflow-hidden rounded-lg ${shimmerClass} ${className}`.trim()}
    style={style}
  />
);

/** Variable-width text line (e.g. 60%, 80%). */
export const SkeletonText: React.FC<SkeletonProps & { width?: string | number }> = ({
  className = '',
  width = '100%',
  style,
}) => (
  <Skeleton
    className={`h-4 ${className}`.trim()}
    style={{ width: typeof width === 'number' ? `${width}%` : width, ...style }}
  />
);

/** Card-shaped skeleton (e.g. stat card). */
export const SkeletonCard: React.FC<SkeletonProps> = ({ className = '', style }) => (
  <div className={`rounded-3xl border border-slate-200 bg-white p-6 ${className}`.trim()} style={style}>
    <Skeleton className="h-3 w-20 mb-3" />
    <Skeleton className="h-8 w-24" />
  </div>
);

/** Table skeleton: header row + N body rows. */
export interface SkeletonTableProps extends SkeletonProps {
  columns?: number;
  rows?: number;
  showToolbar?: boolean;
}

export const SkeletonTable: React.FC<SkeletonTableProps> = ({
  columns = 4,
  rows = 10,
  showToolbar = true,
  className = '',
}) => {
  const { t } = useTranslation();
  return (
    <div className={className} aria-busy aria-live="polite">
      {showToolbar && (
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <Skeleton className="h-10 w-64 rounded-xl" />
          <Skeleton className="h-10 w-48 rounded-xl" />
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" aria-label={t('common.loading')}>
          <caption className="sr-only">{t('common.loading')}</caption>
          <thead>
          <tr className="text-left border-b border-slate-200">
            {Array.from({ length: columns }).map((_, i) => (
              <th key={i} className="pb-3 pr-4">
                <Skeleton className="h-4 w-24" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, rowIndex) => (
            <tr key={rowIndex} className="border-b border-slate-100">
              {Array.from({ length: columns }).map((_, colIndex) => (
                <td key={colIndex} className="py-3 pr-4">
                  <Skeleton className="h-4 w-full max-w-[8rem]" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-4 mt-4 pt-4 border-t border-slate-200">
      <Skeleton className="h-4 w-48" />
      <div className="flex gap-2">
        <Skeleton className="h-9 w-20 rounded-lg" />
        <Skeleton className="h-9 w-16 rounded-lg" />
      </div>
    </div>
  </div>
  );
};

/** Grid of stat cards (e.g. 4 cards). */
export const SkeletonStatCards: React.FC<SkeletonProps & { count?: number }> = ({
  count = 4,
  className = '',
}) => (
  <div className={`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 ${className}`.trim()}>
    {Array.from({ length: count }).map((_, i) => (
      <SkeletonCard key={i} />
    ))}
  </div>
);

/** Chart placeholder (title + block). */
export const SkeletonChart: React.FC<SkeletonProps> = ({ className = '' }) => (
  <div className={`rounded-3xl border border-slate-200 bg-white p-6 ${className}`.trim()}>
    <Skeleton className="h-5 w-48 mb-4" />
    <Skeleton className="h-72 w-full rounded-2xl" />
  </div>
);

/** Page header (title + subtitle + optional button). */
export const SkeletonPageHeader: React.FC<SkeletonProps & { showButton?: boolean }> = ({
  showButton = true,
  className = '',
}) => (
  <div className={`flex justify-between items-center ${className}`.trim()}>
    <div>
      <Skeleton className="h-9 w-64 mb-2" />
      <Skeleton className="h-4 w-96" />
    </div>
    {showButton && <Skeleton className="h-11 w-40 rounded-xl" />}
  </div>
);

/** Composable: full page skeleton (header + stats + table). */
export const SkeletonPage: React.FC<{ showStats?: boolean; tableRows?: number }> = ({
  showStats = false,
  tableRows = 10,
}) => (
  <div className="space-y-8">
    <SkeletonPageHeader />
    {showStats && <SkeletonStatCards />}
    <div className="bg-white rounded-[2rem] border border-slate-200 shadow-sm overflow-hidden p-6 md:p-8">
      <SkeletonTable rows={tableRows} columns={5} />
    </div>
  </div>
);

export default Skeleton;
