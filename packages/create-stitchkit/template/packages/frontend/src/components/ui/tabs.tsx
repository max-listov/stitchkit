'use client';

/**
 * Tabs - Компонент табов на основе Radix UI
 *
 * Композиция примитивов для максимальной гибкости.
 * Плавная анимация активного таба через Framer Motion.
 *
 * Использование:
 * <Tabs value={activeTab} onValueChange={setActiveTab}>
 *   <TabsList>
 *     <TabsTrigger value="tab1">Tab 1</TabsTrigger>
 *     <TabsTrigger value="tab2">Tab 2</TabsTrigger>
 *   </TabsList>
 * </Tabs>
 */

import * as TabsPrimitive from '@radix-ui/react-tabs';
import { motion } from 'framer-motion';
import type { ComponentPropsWithoutRef, ComponentRef, CSSProperties } from 'react';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
} from 'react';
import { cn } from '@/lib/utils';

// ==========================================================================
// Context для layoutId анимации
// ==========================================================================

interface TabsContext {
  layoutId: string;
  activeValue?: string;
  disableAnimation?: boolean;
}

const TabsAnimationContext = createContext<TabsContext>({
  layoutId: 'tabs-indicator',
  activeValue: undefined,
  disableAnimation: false,
});

// ==========================================================================
// Tabs Root
// ==========================================================================

interface TabsProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.Root> {
  /** Уникальный ID для анимации (нужен если несколько Tabs на странице) */
  layoutId?: string;
  /** Отключить анимацию sliding indicator */
  disableAnimation?: boolean;
}

const Tabs = forwardRef<ComponentRef<typeof TabsPrimitive.Root>, TabsProps>(function Tabs(
  {
    className,
    layoutId: layoutIdProp,
    disableAnimation = false,
    value,
    defaultValue,
    onValueChange,
    ...props
  },
  ref,
) {
  // Если layoutId не задан — генерируем стабильный уникальный, чтобы несколько Tabs
  // на странице не "склеивались" по layout-анимации.
  const reactId = useId();
  const layoutId = layoutIdProp ?? `tabs-indicator-${reactId}`;

  const isControlled = value !== undefined;
  const [uncontrolledValue, setUncontrolledValue] = useState<string | undefined>(defaultValue);

  const handleValueChange = useCallback(
    (nextValue: string) => {
      if (!isControlled) setUncontrolledValue(nextValue);
      onValueChange?.(nextValue);
    },
    [isControlled, onValueChange],
  );

  const activeValue = isControlled ? value : uncontrolledValue;

  const contextValue = useMemo(
    () => ({ layoutId, activeValue, disableAnimation }),
    [layoutId, activeValue, disableAnimation],
  );

  // Важно: Radix Tabs поддерживает controlled и uncontrolled режимы. Чтобы не
  // передать одновременно value и defaultValue — задаём пропы условно.
  const rootProps: ComponentPropsWithoutRef<typeof TabsPrimitive.Root> = {
    ...props,
    className: cn('flex flex-col gap-2', className),
    onValueChange: handleValueChange,
  };

  if (activeValue !== undefined) rootProps.value = activeValue;

  return (
    <TabsAnimationContext.Provider value={contextValue}>
      <TabsPrimitive.Root ref={ref} {...rootProps} />
    </TabsAnimationContext.Provider>
  );
});

// ==========================================================================
// TabsList
// ==========================================================================

const TabsList = forwardRef<
  ComponentRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn('inline-flex items-center gap-1 rounded-xl bg-muted p-1 w-fit', className)}
      {...props}
    />
  );
});

// ==========================================================================
// TabsTrigger
// ==========================================================================

const TabsTrigger = forwardRef<
  ComponentRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, children, value, ...props }, ref) {
  const { layoutId, activeValue, disableAnimation } = useContext(TabsAnimationContext);
  const isActive = value === activeValue;
  const indicatorClassName = 'absolute inset-0 rounded-lg bg-background shadow-sm';
  const indicatorStyle: CSSProperties = { pointerEvents: 'none' };

  return (
    <TabsPrimitive.Trigger
      ref={ref}
      value={value}
      className={cn(
        'relative flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 cursor-pointer whitespace-nowrap',
        'text-muted-foreground hover:text-foreground',
        'data-[state=active]:text-foreground',
        className,
      )}
      {...props}
    >
      {isActive &&
        (disableAnimation ? (
          <div aria-hidden='true' className={indicatorClassName} style={indicatorStyle} />
        ) : (
          <motion.div
            aria-hidden='true'
            layoutId={layoutId}
            className={indicatorClassName}
            transition={{ type: 'spring', stiffness: 500, damping: 35 }}
            style={indicatorStyle}
          />
        ))}
      <span className='relative z-10'>{children}</span>
    </TabsPrimitive.Trigger>
  );
});

// ==========================================================================
// TabsContent
// ==========================================================================

const TabsContent = forwardRef<
  ComponentRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn('flex-1 outline-none', className)}
      {...props}
    />
  );
});

Tabs.displayName = 'Tabs';
TabsList.displayName = 'TabsList';
TabsTrigger.displayName = 'TabsTrigger';
TabsContent.displayName = 'TabsContent';

// ==========================================================================
// Exports
// ==========================================================================

export { Tabs, TabsContent, TabsList, TabsTrigger };
