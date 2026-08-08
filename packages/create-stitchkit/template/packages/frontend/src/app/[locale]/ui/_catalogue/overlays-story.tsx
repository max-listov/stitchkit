'use client';

import { IconDots, IconSettings, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import {
  AdaptiveModal,
  Button,
  ConfirmationModal,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  toast,
} from '@/components/ui';
import { StorySection } from './catalogue-shell';

export function OverlaysStory() {
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [notifications, setNotifications] = useState(true);

  return (
    <div>
      <StorySection title='Adaptive surfaces'>
        <div className='flex flex-wrap gap-3'>
          <Button onClick={() => setModalOpen(true)}>Adaptive modal</Button>
          <Button variant='destructive' onClick={() => setConfirmOpen(true)}>
            Confirmation
          </Button>
          <Drawer>
            <DrawerTrigger asChild>
              <Button variant='outline'>Drawer</Button>
            </DrawerTrigger>
            <DrawerContent>
              <DrawerHeader>
                <DrawerTitle>Project settings</DrawerTitle>
                <DrawerDescription>A composable mobile-first surface.</DrawerDescription>
              </DrawerHeader>
              <div className='px-4 text-sm text-muted-foreground'>
                Use drawers for contextual actions without replacing the current page.
              </div>
              <DrawerFooter>
                <DrawerClose asChild>
                  <Button>Done</Button>
                </DrawerClose>
              </DrawerFooter>
            </DrawerContent>
          </Drawer>
        </div>
        <AdaptiveModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          title='Adaptive modal'
          mobileVariant='sheet'
          footer={
            <Button className='w-full' onClick={() => setModalOpen(false)}>
              Save changes
            </Button>
          }
        >
          <div className='px-4 pb-6 text-sm text-muted-foreground'>
            Centered on desktop, touch-friendly sheet on compact screens.
          </div>
        </AdaptiveModal>
        <ConfirmationModal
          isOpen={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            toast.success('Action confirmed');
          }}
          title='Archive project?'
          description='The project remains available in your history.'
          confirmText='Archive'
          variant='destructive'
        />
      </StorySection>

      <StorySection title='Menus and contextual help'>
        <div className='flex items-center gap-3'>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size='icon' variant='outline' aria-label='Open project menu'>
                <IconDots />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='start'>
              <DropdownMenuLabel>Project</DropdownMenuLabel>
              <DropdownMenuItem>
                <IconSettings /> Settings <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem
                checked={notifications}
                onCheckedChange={setNotifications}
              >
                Notifications
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className='text-destructive'>
                <IconTrash /> Archive
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant='ghost'>Why server cache?</Button>
              </TooltipTrigger>
              <TooltipContent>
                It protects external rate limits and keeps rendering predictable.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </StorySection>
    </div>
  );
}
