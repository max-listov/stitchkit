'use client';

import {
  IconLayoutSidebarLeftCollapseFilled,
  IconLayoutSidebarLeftExpandFilled,
  IconMenu2,
  IconX,
} from '@tabler/icons-react';
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import { useMediaQuery } from '@/hooks';
import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

export interface SidebarNavItem {
  name: string;
  href: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

export interface SidebarProps {
  /** Navigation items */
  navigation: SidebarNavItem[];
  /** Logo/header content */
  logo?: ReactNode;
  /** Link for logo click */
  logoHref?: string;
  /** Footer content - render prop with collapsed state */
  footer?: ReactNode | ((collapsed: boolean) => ReactNode);
  /** Default collapsed state for desktop */
  defaultCollapsed?: boolean;
  /** Custom class for sidebar container */
  className?: string;
  /** Breakpoint for mobile/desktop switch */
  mobileBreakpoint?: 'md' | 'lg';
  /** Desktop placement */
  variant?: 'attached' | 'floating';
  /** Whether the desktop rail can collapse */
  collapsible?: boolean;
}

const sidebarBreakpoints = {
  md: {
    query: '(min-width: 768px)',
    mobileClassName: 'md:hidden',
    desktopClassName: 'md:flex',
  },
  lg: {
    query: '(min-width: 1024px)',
    mobileClassName: 'lg:hidden',
    desktopClassName: 'lg:flex',
  },
};

// =============================================================================
// Context
// =============================================================================

interface SidebarContextValue {
  collapsed: boolean;
  setCollapsed: (value: boolean) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebarContext() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error('Sidebar components must be used within Sidebar');
  }
  return context;
}

// =============================================================================
// Navigation Content (shared between mobile & desktop)
// =============================================================================

function NavigationContent({
  navigation,
  collapsed = false,
  onNavigate,
}: {
  navigation: SidebarNavItem[];
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav className='flex-1 space-y-1 p-2'>
      {navigation.map((item) => {
        // Exact match only - no startsWith to avoid /admin matching /admin/users
        const isActive = pathname === item.href;

        return (
          <Link
            key={item.name}
            href={item.href}
            onClick={onNavigate}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              // Icon stays LEFT, never moves. Text fades out.
              'flex min-w-0 items-start gap-3 overflow-hidden rounded-md px-3 py-2 text-sm transition-colors',
              isActive
                ? 'bg-muted text-foreground font-medium hover:bg-muted/80'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
            )}
            title={collapsed ? item.name : undefined}
          >
            <item.icon size={18} className='mt-0.5 shrink-0' />
            <span
              className={cn(
                'min-w-0 flex-1 break-words leading-5 transition-opacity duration-200',
                collapsed && 'whitespace-nowrap',
              )}
              style={{
                opacity: collapsed ? 0 : 1,
              }}
            >
              {item.name}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

// =============================================================================
// Mobile Sidebar (Drawer)
// =============================================================================

function MobileSidebar({
  navigation,
  logo,
  logoHref,
  footer,
  mobileBreakpoint,
}: Omit<SidebarProps, 'defaultCollapsed' | 'className'>) {
  const [open, setOpen] = useState(false);
  const breakpoint = mobileBreakpoint ?? 'lg';
  const isDesktop = useMediaQuery(sidebarBreakpoints[breakpoint].query);

  // Close drawer when screen becomes desktop
  useEffect(() => {
    if (isDesktop && open) {
      setOpen(false);
    }
  }, [isDesktop, open]);

  return (
    <Drawer direction='left' open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button
          aria-label='Open navigation'
          variant='ghost'
          size='icon'
          className={cn(
            'absolute left-3 top-2 z-50',
            sidebarBreakpoints[breakpoint].mobileClassName,
          )}
        >
          <IconMenu2 size={22} />
        </Button>
      </DrawerTrigger>
      <DrawerContent className='w-64' aria-describedby={undefined}>
        {/* Accessibility: hidden title for screen readers */}
        <DrawerTitle className='sr-only'>Navigation Menu</DrawerTitle>
        {/* Header */}
        <div className='h-14 flex items-center justify-between px-3 border-b border-border/50'>
          {logo && logoHref ? (
            <Link
              href={logoHref}
              className='font-display font-semibold text-sm'
              onClick={() => setOpen(false)}
            >
              {logo}
            </Link>
          ) : (
            <span className='font-display font-semibold text-sm'>{logo}</span>
          )}
          <DrawerClose asChild>
            <Button
              aria-label='Close navigation'
              variant='ghost'
              size='icon'
              className='h-8 w-8'
            >
              <IconX size={16} />
            </Button>
          </DrawerClose>
        </div>

        <NavigationContent navigation={navigation} onNavigate={() => setOpen(false)} />

        {/* Footer */}
        {footer && (
          <div className='p-3'>{typeof footer === 'function' ? footer(false) : footer}</div>
        )}
      </DrawerContent>
    </Drawer>
  );
}

// =============================================================================
// Desktop Sidebar
// =============================================================================

function DesktopSidebar({
  navigation,
  logo,
  logoHref,
  footer,
  defaultCollapsed = false,
  className,
  mobileBreakpoint = 'lg',
  variant = 'attached',
  collapsible = true,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <SidebarContext.Provider value={{ collapsed, setCollapsed }}>
      <aside
        className={cn(
          'hidden flex-col transition-[width] duration-300',
          sidebarBreakpoints[mobileBreakpoint].desktopClassName,
          variant === 'floating'
            ? 'absolute left-5 top-20 z-30 max-h-[calc(100dvh-6.5rem)] overflow-y-auto rounded-2xl border border-border bg-card/90 shadow-xl shadow-black/5 backdrop-blur'
            : 'h-full shrink-0 border-r border-border/50 bg-muted/30',
          collapsed && collapsible ? 'w-14' : 'w-60',
          className,
        )}
      >
        {/* Header */}
        <div className='h-12 flex items-center px-3 border-b border-border/50 relative'>
          {/* Logo - left, fades out */}
          <div
            className='transition-opacity duration-200'
            style={{
              opacity: collapsed ? 0 : 1,
              pointerEvents: collapsed ? 'none' : 'auto',
            }}
          >
            {logo && logoHref ? (
              <Link
                href={logoHref}
                className='font-display font-semibold text-base whitespace-nowrap text-foreground'
              >
                {logo}
              </Link>
            ) : (
              <span className='font-display font-semibold text-base whitespace-nowrap text-foreground'>
                {logo}
              </span>
            )}
          </div>
          {/* Button - right when expanded, center when collapsed */}
          {collapsible ? (
            <Button
              aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
              variant='ghost'
              size='icon'
              onClick={() => setCollapsed(!collapsed)}
              className='absolute right-3 h-8 w-8'
            >
              {collapsed ? (
                <IconLayoutSidebarLeftExpandFilled size={16} />
              ) : (
                <IconLayoutSidebarLeftCollapseFilled size={16} />
              )}
            </Button>
          ) : null}
        </div>

        <NavigationContent navigation={navigation} collapsed={collapsed} />

        {/* Footer */}
        {footer && (
          <div className='p-2'>{typeof footer === 'function' ? footer(collapsed) : footer}</div>
        )}
      </aside>
    </SidebarContext.Provider>
  );
}

// =============================================================================
// Main Sidebar Component
// =============================================================================

export function Sidebar(props: SidebarProps) {
  return (
    <>
      <MobileSidebar {...props} />
      <DesktopSidebar {...props} />
    </>
  );
}

// =============================================================================
// Sidebar Footer Link (helper component)
// =============================================================================

export function SidebarFooterLink({
  href,
  icon: Icon,
  children,
  onClick,
}: {
  href: string;
  icon: ComponentType<{ size?: number }>;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className='flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground'
    >
      <Icon size={18} />
      <span>{children}</span>
    </Link>
  );
}
