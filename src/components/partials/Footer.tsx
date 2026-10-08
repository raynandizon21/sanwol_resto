import React from 'react';
import { useTranslation } from 'react-i18next';

export const Footer: React.FC = () => {
  const { t } = useTranslation();
  return (
    <footer className="h-12 px-8 flex items-center justify-between bg-white border-t border-gray-100 text-xs text-brand-muted shrink-0">
      <span>{t('footer.copyright_text')}</span>
      <span className="hidden sm:inline">{t('footer.built_for')}</span>
    </footer>
  );
};

