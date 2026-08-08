'use client';

import {
  type ComponentPropsWithoutRef,
  type ComponentRef,
  createContext,
  forwardRef,
  type HTMLAttributes,
  useContext,
} from 'react';
import { Drawer as DrawerPrimitive } from 'vaul';
import { cn } from '@/lib/utils';

type DrawerDirection = 'left' | 'right' | 'top' | 'bottom';

const DrawerDirectionContext = createContext<DrawerDirection>('right');

const Drawer = ({
  shouldScaleBackground = true,
  direction = 'right',
  ...props
}: ComponentPropsWithoutRef<typeof DrawerPrimitive.Root>) => (
  <DrawerDirectionContext.Provider value={direction}>
    <DrawerPrimitive.Root
      direction={direction}
      shouldScaleBackground={shouldScaleBackground}
      {...props}
    />
  </DrawerDirectionContext.Provider>
);
Drawer.displayName = 'Drawer';

const DrawerTrigger = DrawerPrimitive.Trigger;

const DrawerPortal = DrawerPrimitive.Portal;

const DrawerClose = DrawerPrimitive.Close;

const DrawerOverlay = forwardRef<
  ComponentRef<typeof DrawerPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DrawerPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DrawerPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-overlay backdrop-blur-sm', className)}
    {...props}
  />
));
DrawerOverlay.displayName = DrawerPrimitive.Overlay.displayName;

const DrawerContent = forwardRef<
  ComponentRef<typeof DrawerPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DrawerPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const direction = useContext(DrawerDirectionContext);
  const directionStyles = {
    left: 'inset-y-3 left-3 h-auto w-[min(22rem,calc(100vw-1.5rem))] rounded-2xl',
    right: 'inset-y-3 right-3 h-auto w-[min(22rem,calc(100vw-1.5rem))] rounded-2xl',
    top: 'inset-x-3 top-3 w-auto rounded-2xl',
    bottom: 'inset-x-3 bottom-3 w-auto rounded-2xl',
  };

  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DrawerPrimitive.Content
        ref={ref}
        className={cn(
          'fixed z-50 flex flex-col overflow-hidden border bg-card shadow-xl',
          directionStyles[direction],
          className,
        )}
        {...props}
      >
        {/* Handle for bottom/top drawers */}
        {(direction === 'bottom' || direction === 'top') && (
          <div
            className={cn(
              'mx-auto w-12 h-1.5 rounded-full bg-muted-foreground/20',
              direction === 'bottom' ? 'mt-4' : 'mb-4 mt-auto',
            )}
          />
        )}
        {children}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  );
});
DrawerContent.displayName = 'DrawerContent';

const DrawerHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 p-4', className)} {...props} />
);
DrawerHeader.displayName = 'DrawerHeader';

const DrawerFooter = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('mt-auto flex flex-col gap-2 p-4', className)} {...props} />
);
DrawerFooter.displayName = 'DrawerFooter';

const DrawerTitle = forwardRef<
  ComponentRef<typeof DrawerPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DrawerPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DrawerPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight', className)}
    {...props}
  />
));
DrawerTitle.displayName = DrawerPrimitive.Title.displayName;

const DrawerDescription = forwardRef<
  ComponentRef<typeof DrawerPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DrawerPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DrawerPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
DrawerDescription.displayName = DrawerPrimitive.Description.displayName;

export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
  DrawerTrigger,
};
