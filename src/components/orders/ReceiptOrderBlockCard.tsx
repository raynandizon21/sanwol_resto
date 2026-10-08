import React from 'react';
import { cn } from '../../lib/utils';

type ReceiptOrderBlockCardProps = {
    title: string;
    /** Bottom of card (below items), e.g. "Block total · ₱3,700" */
    blockTotalLabel?: string;
    children: React.ReactNode;
    className?: string;
};

/** Grouped receipt block — light card with subtle border/shadow. */
export function ReceiptOrderBlockCard({ title, blockTotalLabel, children, className }: ReceiptOrderBlockCardProps) {
    return (
        <div
            className={cn(
                'rounded-2xl border border-gray-200/90 bg-white shadow-[0_10px_40px_-16px_rgba(15,23,42,0.12)] overflow-hidden',
                className
            )}
        >
            <div className="px-4 py-4 sm:px-5 border-b border-gray-100 bg-gray-50">
                <h4 className="text-[13px] sm:text-sm font-semibold tracking-[0.12em] text-brand-text uppercase">{title}</h4>
            </div>
            <div className="p-4 sm:p-5 space-y-5">{children}</div>
            {blockTotalLabel ? (
                <div className="px-4 py-3.5 sm:px-5 border-t border-gray-100 bg-gray-50/80 flex justify-end">
                    <p
                        className="text-base sm:text-lg font-bold font-mono tracking-[0.08em] uppercase text-slate-800 tabular-nums text-right"
                        aria-label={blockTotalLabel}
                    >
                        {blockTotalLabel}
                    </p>
                </div>
            ) : null}
        </div>
    );
}
