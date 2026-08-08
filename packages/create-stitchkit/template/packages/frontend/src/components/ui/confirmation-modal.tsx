'use client';

import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { AnimatePresence, motion, type Transition } from 'framer-motion';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

export interface ConfirmationModalProps {
  /** Controlled open state */
  isOpen: boolean;
  /** Called when modal should close */
  onClose: () => void;
  /** Called when user confirms the action */
  onConfirm: () => void;
  /** Modal title */
  title: string;
  /** Description text */
  description?: string;
  /** Custom content instead of description */
  children?: ReactNode;
  /** Text for cancel button */
  cancelText?: string;
  /** Text for confirm button */
  confirmText?: string;
  /** Visual variant for confirm button */
  variant?: 'default' | 'destructive';
  /** Loading state for confirm button */
  isLoading?: boolean;
}

const BACKDROP_TRANSITION: Transition = { duration: 0.2 };
const MODAL_OPEN_TRANSITION: Transition = { type: 'spring', stiffness: 400, damping: 30 };
const MODAL_CLOSE_TRANSITION: Transition = { type: 'tween', duration: 0.15 };

const ANIMATION = {
  backdrop: BACKDROP_TRANSITION,
  modal: {
    open: MODAL_OPEN_TRANSITION,
    close: MODAL_CLOSE_TRANSITION,
  },
};

export function ConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  children,
  cancelText = 'Cancel',
  confirmText = 'Confirm',
  variant = 'default',
  isLoading = false,
}: ConfirmationModalProps) {
  return (
    <AlertDialogPrimitive.Root open={isOpen} onOpenChange={onClose}>
      <AnimatePresence>
        {isOpen && (
          <AlertDialogPrimitive.Portal forceMount>
            {/* Backdrop */}
            <AlertDialogPrimitive.Overlay asChild>
              <motion.div
                className='fixed inset-0 z-60 bg-overlay backdrop-blur-sm'
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={ANIMATION.backdrop}
              />
            </AlertDialogPrimitive.Overlay>

            {/* Content */}
            <AlertDialogPrimitive.Content asChild>
              <div className='fixed inset-0 z-70 flex items-center justify-center p-4'>
                <motion.div
                  className={cn(
                    'w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl outline-none',
                  )}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{
                    opacity: 1,
                    scale: 1,
                    transition: ANIMATION.modal.open,
                  }}
                  exit={{
                    opacity: 0,
                    scale: 0.95,
                    transition: ANIMATION.modal.close,
                  }}
                >
                  {/* Title */}
                  <AlertDialogPrimitive.Title className='text-xl font-semibold'>
                    {title}
                  </AlertDialogPrimitive.Title>

                  {/* Description or custom content */}
                  {description && (
                    <AlertDialogPrimitive.Description className='mt-2 text-muted-foreground'>
                      {description}
                    </AlertDialogPrimitive.Description>
                  )}
                  {children && <div className='mt-2'>{children}</div>}

                  {/* Actions */}
                  <div className='mt-6 flex justify-end gap-3'>
                    <AlertDialogPrimitive.Cancel asChild>
                      <Button variant='outline' disabled={isLoading}>
                        {cancelText}
                      </Button>
                    </AlertDialogPrimitive.Cancel>
                    <AlertDialogPrimitive.Action asChild>
                      <Button
                        variant={variant === 'destructive' ? 'destructive' : 'default'}
                        onClick={onConfirm}
                        disabled={isLoading}
                      >
                        {isLoading ? 'Loading...' : confirmText}
                      </Button>
                    </AlertDialogPrimitive.Action>
                  </div>
                </motion.div>
              </div>
            </AlertDialogPrimitive.Content>
          </AlertDialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </AlertDialogPrimitive.Root>
  );
}
