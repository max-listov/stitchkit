'use client';

import { IconCheck, IconCopy } from '@tabler/icons-react';
import { type ReactNode, useCallback, useState } from 'react';
import { cn } from '@/lib/utils';

export interface CopyableTextProps {
  /** Value to copy to clipboard */
  value: string;
  /** Custom display content (defaults to value) */
  children?: ReactNode;
  /** Additional class names */
  className?: string;
  /** Icon size (default: 14) */
  iconSize?: number;
  /** Duration to show success state in ms (default: 2000) */
  successDuration?: number;
  /** Callback after successful copy */
  onCopy?: (value: string) => void;
}

/**
 * Text with click-to-copy functionality.
 * Shows copy icon on hover, checkmark on success.
 *
 * @example
 * // Basic usage
 * <CopyableText value={email} />
 *
 * // Custom display
 * <CopyableText value={fullId}>
 *   {shortId}
 * </CopyableText>
 *
 * // Custom styling
 * <CopyableText value={code} className="font-mono text-xs" />
 */
export function CopyableText({
  value,
  children,
  className,
  iconSize = 14,
  successDuration = 2000,
  onCopy,
}: CopyableTextProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopy?.(value);
      setTimeout(() => setCopied(false), successDuration);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [value, successDuration, onCopy]);

  return (
    <button
      type='button'
      onClick={handleCopy}
      className={cn(
        'group inline-flex items-center gap-1.5 text-left transition-colors',
        'text-muted-foreground hover:text-foreground',
        'cursor-pointer',
        className,
      )}
      title={`Copy: ${value}`}
    >
      <span className='truncate'>{children ?? value}</span>
      <span className='shrink-0'>
        {copied ? (
          <IconCheck size={iconSize} className='text-success' aria-label='Copied' />
        ) : (
          <IconCopy
            size={iconSize}
            className='opacity-0 group-hover:opacity-50 transition-opacity'
            aria-label='Copy to clipboard'
          />
        )}
      </span>
    </button>
  );
}
