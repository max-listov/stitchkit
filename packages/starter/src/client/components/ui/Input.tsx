import type { InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export function Input({ label, error, hint, className = '', id, ...props }: InputProps) {
  const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');

  return (
    <div className='flex flex-col gap-1.5'>
      {label && (
        <label htmlFor={inputId} className='text-xs font-medium text-text-dim'>
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`w-full px-3 py-2 text-sm bg-bg-elevated border rounded-lg text-text placeholder:text-text-muted/50 outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent/30 ${error ? 'border-danger focus:border-danger focus:ring-danger/30' : 'border-border'} ${className}`}
        {...props}
      />
      {error && <p className='text-xs text-danger'>{error}</p>}
      {!error && hint && <p className='text-xs text-text-muted'>{hint}</p>}
    </div>
  );
}

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export function Textarea({ label, error, className = '', id, ...props }: TextareaProps) {
  const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');

  return (
    <div className='flex flex-col gap-1.5'>
      {label && (
        <label htmlFor={inputId} className='text-xs font-medium text-text-dim'>
          {label}
        </label>
      )}
      <textarea
        id={inputId}
        className={`w-full px-3 py-2 text-sm bg-bg-elevated border rounded-lg text-text placeholder:text-text-muted/50 outline-none transition-colors resize-y min-h-[80px] focus:border-accent focus:ring-1 focus:ring-accent/30 ${error ? 'border-danger' : 'border-border'} ${className}`}
        {...props}
      />
      {error && <p className='text-xs text-danger'>{error}</p>}
    </div>
  );
}
