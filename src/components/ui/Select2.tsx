import React from 'react';
import { useTranslation } from 'react-i18next';
import Select, { components, ControlProps, SingleValueProps } from 'react-select';
import { cn } from '../../lib/utils';

interface Option {
  value: string | number;
  label: string;
}

interface Select2Props {
  options: Option[];
  value: string | number | null;
  onChange: (value: string | number | null) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  leftIcon?: React.ReactNode;
  clearable?: boolean;
  variant?: 'default' | 'compact';
}

const Control = ({ children, ...props }: ControlProps<Option, false>) => {
  const { leftIcon } = (props.selectProps as any);
  return (
    <components.Control {...props}>
      {leftIcon && (
        <div className="pl-4 text-gray-400 shrink-0">
          {leftIcon}
        </div>
      )}
      {children}
    </components.Control>
  );
};

const SingleValue = ({ children, ...props }: SingleValueProps<Option, false>) => {
  const { leftIcon } = (props.selectProps as any);
  return (
    <components.SingleValue {...props}>
      <div className={cn("flex items-center", leftIcon && "ml-1")}>
        {children}
      </div>
    </components.SingleValue>
  );
};

export const Select2: React.FC<Select2Props> = ({
  options,
  value,
  onChange,
  placeholder,
  className,
  disabled = false,
  leftIcon,
  clearable = true,
  variant = 'default',
}) => {
  const { t } = useTranslation();
  const selectedOption = options.find(opt => opt.value === value) || null;

  const isCompact = variant === 'compact';

  return (
    <div className={cn("w-full", className)}>
      <Select
        value={selectedOption}
        onChange={(opt) => onChange(opt ? opt.value : null)}
        options={options}
        placeholder={placeholder || t('common.select_placeholder')}
        isDisabled={disabled}
        isClearable={clearable}
        isSearchable
        // @ts-ignore - passing custom prop to components
        leftIcon={leftIcon}
        components={{
          Control,
          SingleValue
        }}
        classNames={{
          control: () =>
            cn(
              '!rounded-xl !border-gray-200 !bg-gray-50 !shadow-none !cursor-pointer',
              isCompact ? '!min-h-[38px]' : '!min-h-[48px]',
            ),
          placeholder: () => cn('!text-gray-400', isCompact ? '!text-xs' : '!text-sm'),
          input: () => cn('!text-brand-text', isCompact ? '!text-xs' : '!text-sm'),
          singleValue: () => cn('!text-brand-text', isCompact ? '!text-xs' : '!text-sm'),
          menu: () => '!rounded-xl !border !border-gray-100 !shadow-xl !mt-2 !overflow-hidden',
          option: ({ isSelected, isFocused }) => cn(
            '!py-2.5 !px-4 !text-sm !cursor-pointer !transition-colors',
            isSelected ? '!bg-brand-primary/10 !text-brand-primary !font-bold' :
              isFocused ? '!bg-brand-primary/5 !text-brand-text' : '!text-brand-text'
          ),
          valueContainer: () => cn(isCompact ? '!px-2 !py-0' : '!px-2'),
          clearIndicator: () => '!text-gray-400 hover:!text-red-500 !p-1',
          dropdownIndicator: () => '!text-gray-400 !p-1',
        }}
        menuPortalTarget={document.body}
        styles={{
          control: (base, state) => ({
            ...base,
            borderColor: state.isFocused ? 'var(--color-brand-primary)' : 'rgb(226 232 240)',
            boxShadow: state.isFocused ? '0 0 0 2px rgba(79, 70, 229, 0.2)' : 'none',
            '&:hover': {
              borderColor: state.isFocused ? 'var(--color-brand-primary)' : 'rgb(203 213 225)',
            }
          }),
          menuPortal: (base) => ({ ...base, zIndex: 9999 }),
        }}
      />
    </div>
  );
};
