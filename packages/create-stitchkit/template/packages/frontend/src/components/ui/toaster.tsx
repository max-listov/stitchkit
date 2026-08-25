'use client';

import { IconAlertTriangle, IconCheck, IconInfoCircle, IconX } from '@tabler/icons-react';
import { useThemeValue } from '@wrksz/themes/client/use-theme-value';
import type { ReactNode } from 'react';
import { type ExternalToast, Toaster as SonnerToaster, toast as sonnerToast } from 'sonner';

type ToastPosition = 'bottom-center' | 'bottom-right' | 'top-left' | 'top-center' | 'top-right';

interface ToastOptions {
  position?: ToastPosition;
  duration?: number;
}

const getResponsivePosition = (): ToastPosition => {
  if (typeof window === 'undefined') return 'bottom-center';
  return window.innerWidth >= 1024 ? 'bottom-right' : 'bottom-center';
};

const getBaseOptions = (options?: ToastOptions): ExternalToast => ({
  position: options?.position ?? getResponsivePosition(),
  duration: options?.duration,
});

export const toast = {
  success: (message: ReactNode, options?: ToastOptions) =>
    sonnerToast.success(message, getBaseOptions(options)),
  error: (message: ReactNode, options?: ToastOptions) =>
    sonnerToast.error(message, getBaseOptions(options)),
  info: (message: ReactNode, options?: ToastOptions) =>
    sonnerToast.info(message, getBaseOptions(options)),
  warning: (message: ReactNode, options?: ToastOptions) =>
    sonnerToast.warning(message, getBaseOptions(options)),
  loading: (message: ReactNode, options?: ToastOptions) =>
    sonnerToast.loading(message, getBaseOptions(options)),
  custom: sonnerToast.custom,
  dismiss: sonnerToast.dismiss,
};

export function Toaster() {
  // No explicit type argument: since @wrksz/themes 1.2 the parameter describes
  // the MAP, not the value, and it infers `const` — so naming the value union
  // here made the result every member of `string` instead of narrowing it.
  const theme = useThemeValue({
    light: 'light',
    dark: 'dark',
    default: 'system',
  });

  return (
    <SonnerToaster
      theme={theme}
      position='bottom-right'
      icons={{
        success: <IconCheck size={18} stroke={2.5} />,
        error: <IconX size={18} stroke={2.5} />,
        info: <IconInfoCircle size={18} stroke={2} />,
        warning: <IconAlertTriangle size={18} stroke={2} />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex items-center gap-3 w-full p-4 rounded-xl shadow-lg font-sans font-medium text-sm border',
          title: 'font-medium',
          description: 'text-sm opacity-90',
          success: 'bg-success text-success-foreground border-success-foreground/10',
          error: 'bg-destructive text-destructive-foreground border-destructive-foreground/10',
          info: 'bg-card text-card-foreground border-border [&>svg]:text-info',
          warning: 'bg-warning text-warning-foreground border-warning-foreground/10',
        },
      }}
    />
  );
}
