'use client';

/**
 * AdaptiveModal - Адаптивный модальный компонент
 *
 * Mobile: Bottom Sheet с drag-to-dismiss / Fullscreen / Modal
 * Desktop: Center Modal с fade анимацией
 *
 * Powered by Radix UI Dialog & Motion for A11y and Animations
 *
 * ⚠️ ВАЖНО ДЛЯ ИСПОЛЬЗОВАНИЯ:
 * Чтобы exit анимация работала, НЕ оборачивай в условный рендеринг:
 * ❌ {isOpen && <AdaptiveModal />}  // Ломает exit анимацию
 * ✅ <AdaptiveModal isOpen={isOpen} />  // Правильно
 *
 * Компонент должен оставаться в DOM, управляй через проп isOpen
 */

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { IconX } from '@tabler/icons-react';
import {
  AnimatePresence,
  animate,
  motion,
  type PanInfo,
  type Transition,
  useDragControls,
  useMotionValue,
  useTransform,
} from 'framer-motion';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';
import { Button } from '.';

// ==========================================================================
// Types
// ==========================================================================

export interface AdaptiveModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
  showDragIndicator?: boolean;
  desktopWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl';
  className?: string;
  mobileVariant?: 'modal' | 'sheet' | 'fullscreen';
  footer?: ReactNode;
  /** Закрывать по клику вне модалки (по умолчанию true, работает для desktop, mobile modal и sheet, не применяется для fullscreen) */
  closeOnOutsideClick?: boolean;
}

// ==========================================================================
// Constants
// ==========================================================================

const OPEN_TRANSITION: Transition = {
  type: 'tween',
  duration: 0.4,
  ease: [0.16, 1, 0.3, 1],
};
const CLOSE_TRANSITION: Transition = {
  type: 'tween',
  duration: 0.3,
  ease: [0.32, 0, 0.67, 0],
};
const SNAP_BACK_TRANSITION: Transition = { type: 'spring', stiffness: 400, damping: 35 };
const BACKDROP_TRANSITION: Transition = { duration: 0.3 };
const MODAL_OPEN_TRANSITION: Transition = {
  type: 'tween',
  duration: 0.3,
  ease: [0.16, 1, 0.3, 1],
};
const MODAL_CLOSE_TRANSITION: Transition = {
  type: 'tween',
  duration: 0.2,
  ease: [0.32, 0, 0.67, 0],
};

const ANIMATION_CONFIGS = {
  open: OPEN_TRANSITION,
  close: CLOSE_TRANSITION,
  snapBack: SNAP_BACK_TRANSITION,
  backdrop: BACKDROP_TRANSITION,
  modal: {
    open: MODAL_OPEN_TRANSITION,
    close: MODAL_CLOSE_TRANSITION,
  },
};

const DRAG_THRESHOLD = 0.35;
const VELOCITY_THRESHOLD = 200;

const DESKTOP_WIDTHS = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
};

// ==========================================================================
// Internal Components
// ==========================================================================

interface ModalLayoutProps {
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  headerClassName?: string;
  footerClassName?: string;
  showCloseButton?: boolean;
}

const ModalLayout = ({
  title,
  children,
  footer,
  className,
  headerClassName,
  footerClassName,
  showCloseButton = true,
}: ModalLayoutProps) => (
  <div className={cn('flex min-h-0 flex-col overflow-hidden bg-background', className)}>
    {/* Header */}
    {(title || showCloseButton) && (
      <div
        className={cn(
          'flex shrink-0 items-center justify-between px-4 pt-4 pb-2',
          headerClassName,
        )}
      >
        <DialogPrimitive.Title asChild>
          {title ? (
            <h3 className='text-lg font-medium font-display'>{title}</h3>
          ) : (
            <span className='hidden'>Modal</span> // A11y requirement
          )}
        </DialogPrimitive.Title>
        {showCloseButton && (
          <DialogPrimitive.Close asChild>
            <Button variant='ghost' size='icon' className='ml-auto' aria-label='Close dialog'>
              <IconX size={20} stroke={1.5} />
            </Button>
          </DialogPrimitive.Close>
        )}
      </div>
    )}

    {/* Content */}
    <div className='min-h-0 flex-1 overflow-y-auto'>{children}</div>

    {/* Footer */}
    {footer && <div className={cn('shrink-0 px-4 pb-4', footerClassName)}>{footer}</div>}
  </div>
);

// ==========================================================================
// Main Component
// ==========================================================================

export function AdaptiveModal(props: AdaptiveModalProps) {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  const { mobileVariant = 'modal' } = props;
  const isSheet = !isDesktop && mobileVariant === 'sheet';

  return (
    <DialogPrimitive.Root open={props.isOpen} onOpenChange={props.onClose}>
      <AnimatePresence>
        {props.isOpen && (
          <DialogPrimitive.Portal forceMount>
            {isSheet ? (
              <MobileBottomSheet {...props} />
            ) : (
              <>
                {/* Общий Overlay для desktop/mobile modal/fullscreen */}
                <DialogPrimitive.Overlay asChild>
                  <motion.div
                    className='fixed inset-0 z-60 bg-overlay backdrop-blur-sm'
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={ANIMATION_CONFIGS.backdrop}
                  />
                </DialogPrimitive.Overlay>

                <UnifiedContent {...props} isDesktop={isDesktop} />
              </>
            )}
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

// ==========================================================================
// Unified Content (Desktop + Mobile Modal + Fullscreen)
// ==========================================================================

interface UnifiedContentProps extends AdaptiveModalProps {
  isDesktop: boolean;
}

function UnifiedContent({ isDesktop, ...props }: UnifiedContentProps) {
  const { mobileVariant = 'modal', closeOnOutsideClick = true } = props;
  const isFullscreen = !isDesktop && mobileVariant === 'fullscreen';

  return (
    <DialogPrimitive.Content
      asChild
      aria-describedby={undefined}
      onInteractOutside={(event) => {
        if (!closeOnOutsideClick) event.preventDefault();
      }}
    >
      <div
        className={cn(
          'fixed inset-0 z-70 flex',
          !isFullscreen && 'items-center justify-center p-4',
        )}
      >
        <motion.div
          className={cn(
            'pointer-events-auto flex flex-col overflow-hidden bg-background shadow-lg outline-none',
            !isFullscreen && 'rounded-2xl border border-border',
            isDesktop && `w-full ${DESKTOP_WIDTHS[props.desktopWidth || 'md']}`,
            !isDesktop && !isFullscreen && 'w-full max-w-sm',
            isFullscreen && 'h-full w-full',
            !isFullscreen && 'max-h-[85vh]',
            props.className,
          )}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{
            opacity: 1,
            scale: 1,
            transition: ANIMATION_CONFIGS.modal.open,
          }}
          exit={{
            opacity: 0,
            scale: 0.95,
            transition: ANIMATION_CONFIGS.modal.close,
          }}
        >
          <ModalLayout
            title={props.title}
            footer={props.footer}
            className={cn(isFullscreen && 'h-full')}
            footerClassName={
              isFullscreen
                ? 'border-t border-border py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]'
                : undefined
            }
          >
            {props.children}
          </ModalLayout>
        </motion.div>
      </div>
    </DialogPrimitive.Content>
  );
}

// ==========================================================================
// Bottom Sheet Implementation (Special Case)
// ==========================================================================

function MobileBottomSheet(props: AdaptiveModalProps) {
  const { closeOnOutsideClick = true } = props;
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();
  const [screenHeight, setScreenHeight] = useState(1000);
  const y = useMotionValue(screenHeight);

  // Sync screen height
  useEffect(() => {
    setScreenHeight(window.innerHeight);
    const onResize = () => setScreenHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Update initial Y
  useEffect(() => {
    y.set(screenHeight);
  }, [screenHeight, y]);

  const overlayOpacity = useTransform(y, [0, screenHeight * 0.8], [1, 0], {
    clamp: true,
  });

  const closeSheet = () => {
    animate(y, [y.get(), screenHeight], ANIMATION_CONFIGS.close).then(props.onClose);
  };

  const handleDragEnd = (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (info.velocity.y > VELOCITY_THRESHOLD || y.get() > screenHeight * DRAG_THRESHOLD) {
      closeSheet();
    } else {
      animate(y, [y.get(), 0], ANIMATION_CONFIGS.snapBack);
    }
  };

  return (
    <>
      {/*
        Sheet Overlay - We use motion.div directly here for custom opacity animation,
        but wrapped in DialogPrimitive.Overlay logic implicitly via manual close handling
      */}
      <DialogPrimitive.Overlay asChild>
        <motion.div
          className='fixed inset-0 z-60 bg-overlay backdrop-blur-sm'
          style={{ opacity: overlayOpacity }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={ANIMATION_CONFIGS.backdrop}
          onClick={closeOnOutsideClick ? closeSheet : undefined}
        />
      </DialogPrimitive.Overlay>

      <DialogPrimitive.Content
        asChild
        aria-describedby={undefined}
        onInteractOutside={(e) => e.preventDefault()}
      >
        {/*
          We need to prevent Radix from handling pointer-events-none on the container
          because our drag logic needs to work. We manually handle focus trap.
        */}
        <motion.div
          ref={sheetRef}
          className='fixed right-0 bottom-0 left-0 z-70 flex min-h-0 flex-col outline-none'
          style={{ y, maxHeight: '85vh' }}
          initial={{ y: screenHeight }}
          animate={{ y: 0, transition: ANIMATION_CONFIGS.open }}
          exit={{ y: screenHeight, transition: ANIMATION_CONFIGS.close }}
          drag='y'
          dragConstraints={{ top: 0, bottom: screenHeight }}
          dragElastic={{ top: 0.1, bottom: 0 }}
          dragControls={dragControls}
          dragListener={false}
          onDragEnd={handleDragEnd}
        >
          {/* Drag Handle Area */}
          <div
            className='pointer-events-auto absolute right-0 left-0 z-10 flex cursor-grab items-start justify-center active:cursor-grabbing'
            style={{ top: '-20px', height: '20px' }}
            onPointerDown={(e) => dragControls.start(e)}
          >
            {props.showDragIndicator !== false && (
              <div className='mt-2 h-1.5 w-12 rounded-full bg-muted-foreground/30' />
            )}
          </div>

          <ModalLayout
            {...props}
            showCloseButton={false}
            className={cn(
              'rounded-t-2xl border border-border bg-background shadow-xl',
              props.className,
            )}
            headerClassName='text-center pt-5'
          >
            {props.children}
          </ModalLayout>
        </motion.div>
      </DialogPrimitive.Content>
    </>
  );
}
