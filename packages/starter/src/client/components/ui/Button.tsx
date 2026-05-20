import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
}

const variants: Record<Variant, string> = {
  primary:
    'bg-accent text-white shadow-[0_1px_2px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.1)] hover:brightness-110',
  secondary:
    'bg-bg-elevated border border-border text-text shadow-[0_1px_2px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.03)] hover:border-border-hover hover:bg-[#1f1f23]',
  ghost: 'bg-transparent text-text-muted hover:text-text hover:bg-bg-elevated',
  danger: 'bg-danger/10 text-danger border border-danger/20 hover:bg-danger/15',
};

const sizes: Record<Size, string> = {
  sm: 'h-7 px-3 text-xs gap-1.5',
  md: 'h-8 px-3.5 text-sm gap-2',
  lg: 'h-9 px-5 text-sm gap-2',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  children,
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center font-medium rounded-md transition-all duration-100 cursor-pointer select-none disabled:opacity-40 disabled:pointer-events-none ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <svg className='animate-spin w-3.5 h-3.5' viewBox='0 0 24 24' fill='none'>
      <circle
        className='opacity-20'
        cx='12'
        cy='12'
        r='10'
        stroke='currentColor'
        strokeWidth='3'
      />
      <path
        className='opacity-80'
        d='M4 12a8 8 0 018-8'
        stroke='currentColor'
        strokeWidth='3'
        strokeLinecap='round'
      />
    </svg>
  );
}
