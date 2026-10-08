import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface SidePanelProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: 'sm' | 'md' | 'lg';
}

export const SidePanel: React.FC<SidePanelProps> = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  width = 'lg',
}) => {
  const { t } = useTranslation();

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  const widthClass = {
    sm: 'w-full max-w-sm',
    md: 'w-full max-w-md',
    lg: 'w-full max-w-lg',
  }[width];

  const panelContent = (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop - fullscreen over entire viewport including app footer (no close on click) */}
          {/* No backdrop-blur: backdrop-filter over the page makes Chromium flicker black/white on open */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[100] bg-black/40"
          />

          {/* Side Panel */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className={cn(
              'fixed top-0 right-0 h-full bg-white shadow-2xl z-[101] flex flex-col border-l border-gray-100',
              widthClass
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 shrink-0">
              <h3 className="text-xl font-bold text-brand-text">{title}</h3>
              <button
                onClick={onClose}
                title={t('common.close')}
                className="w-8 h-8 flex items-center justify-center rounded-xl bg-gray-50 text-brand-muted hover:bg-red-50 hover:text-red-500 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Body */}
            <div className="px-6 py-6 overflow-y-auto custom-scrollbar flex-1">
              {children}
            </div>

            {/* Footer */}
            {footer && (
              <div className="px-6 py-5 border-t border-gray-100 bg-gray-50/50 shrink-0">
                {footer}
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );

  return typeof document !== 'undefined'
    ? createPortal(panelContent, document.body)
    : null;
};
