'use client';

/**
 * OTP Input
 *
 * Компонент для ввода 6-значного кода верификации.
 * - 6 отдельных полей ввода
 * - Автофокус на следующее поле
 * - Поддержка вставки из буфера
 */

import { type ClipboardEvent, type KeyboardEvent, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface OtpInputProps {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  error?: boolean;
  className?: string;
}

export function OtpInput({
  length = 6,
  value,
  onChange,
  disabled = false,
  error = false,
  className,
}: OtpInputProps) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const inputGroupId = useId();
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  const digits = value.split('').slice(0, length);
  while (digits.length < length) {
    digits.push('');
  }
  const positions = digits.map((digit, position) => ({
    digit,
    id: `${inputGroupId}-digit-${position + 1}`,
    position,
  }));

  const focusInput = (index: number) => {
    const input = inputRefs.current[index];
    if (input) {
      input.focus();
      input.select();
    }
  };

  const handleChange = (index: number, digit: string) => {
    if (disabled) return;

    // Только цифры
    if (digit && !/^\d$/.test(digit)) return;

    const newDigits = [...digits];
    newDigits[index] = digit;
    const newValue = newDigits.join('');
    onChange(newValue);

    // Автофокус на следующее поле
    if (digit && index < length - 1) {
      focusInput(index + 1);
    }
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;

    if (e.key === 'Backspace') {
      e.preventDefault();
      if (digits[index]) {
        // Удалить текущую цифру
        handleChange(index, '');
      } else if (index > 0) {
        // Перейти на предыдущее поле и удалить
        focusInput(index - 1);
        handleChange(index - 1, '');
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      focusInput(index - 1);
    } else if (e.key === 'ArrowRight' && index < length - 1) {
      e.preventDefault();
      focusInput(index + 1);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    if (disabled) return;

    e.preventDefault();
    const pastedData = e.clipboardData.getData('text');
    const digits = pastedData.replace(/\D/g, '').slice(0, length);

    if (digits.length > 0) {
      onChange(digits);
      // Фокус на последнюю заполненную цифру или следующую пустую
      const focusIndex = Math.min(digits.length, length - 1);
      focusInput(focusIndex);
    }
  };

  return (
    <div className={cn('flex gap-2 justify-center', className)}>
      {positions.map(({ digit, id, position }) => (
        <input
          key={id}
          ref={(el) => {
            inputRefs.current[position] = el;
          }}
          type='text'
          inputMode='numeric'
          maxLength={1}
          value={digit}
          disabled={disabled}
          onChange={(e) => handleChange(position, e.target.value)}
          onKeyDown={(e) => handleKeyDown(position, e)}
          onPaste={handlePaste}
          onFocus={() => setFocusedIndex(position)}
          onBlur={() => setFocusedIndex(null)}
          className={cn(
            'w-12 h-14 text-center text-2xl font-mono font-semibold',
            'bg-background border rounded-lg',
            'focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary',
            'transition-all duration-150',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            error ? 'border-destructive focus:ring-destructive' : 'border-border',
            focusedIndex === position && 'scale-105',
          )}
          aria-label={`Digit ${position + 1}`}
        />
      ))}
    </div>
  );
}
