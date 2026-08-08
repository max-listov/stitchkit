import type { ReactNode } from 'react';
import { Label } from './label';

interface FieldProps {
  label: string;
  htmlFor: string;
  description?: string;
  error?: string;
  children: ReactNode;
}

export function Field({ label, htmlFor, description, error, children }: FieldProps) {
  const messageId = `${htmlFor}-message`;
  return (
    <div className='grid gap-2'>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {(error || description) && (
        <p
          id={messageId}
          className={error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
        >
          {error ?? description}
        </p>
      )}
    </div>
  );
}
