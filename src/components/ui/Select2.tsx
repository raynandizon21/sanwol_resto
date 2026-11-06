import React from 'react';
import { useTranslation } from 'react-i18next';
import Select, { components, ControlProps, SingleValueProps } from 'react-select';
import CreatableSelect from 'react-select/creatable';
import { cn } from '../../lib/utils';

interface Option {
  value: string | number;
  label: string;
}

/** Options under a heading (react-select's grouped options). */
export interface Select2Group {
  label: string;
  options: Option[];
}

const isGroup = (o: Option | Select2Group): o is Select2Group => Array.isArray((o as Select2Group).options);

interface Select2Props {
  /** Plain options, or groups of them (shown under their heading). */
  options: (Option | Select2Group)[];
  value: string | number | null;
  onChange: (value: string | number | null) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  leftIcon?: React.ReactNode;
  clearable?: boolean;
  variant?: 'default' | 'compact';
  /** Lets the user type a value that isn't in the list (onChange gets the typed text). */
  creatable?: boolean;
  /** Label of the "use what I typed" row when creatable. */
  formatCreateLabel?: (input: string) => string;
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
  creatable = false,
  formatCreateLabel,
}) => {
  const { t } = useTranslation();
  const flatOptions = options.flatMap((o) => (isGroup(o) ? o.options : [o]));
  const selectedOption = flatOptions.find(opt => opt.value === value) || null;

  const isCompact = variant === 'compact';
  const SelectComponent = (creatable ? CreatableSelect : Select) as typeof Select;
  const creatableProps = creatable && formatCreateLabel ? { formatCreateLabel } : {};

  return (
    <div className={cn("w-full", className)}>
      <SelectComponent
        {...creatableProps}
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
          groupHeading: () => '!text-[11px] !font-bold !uppercase !tracking-wider !text-brand-muted !px-4 !pt-2',
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
