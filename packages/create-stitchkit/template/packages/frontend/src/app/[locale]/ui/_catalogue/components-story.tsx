'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { DataStory } from './data-story';
import { MotionStory } from './motion-story';
import { OverlaysStory } from './overlays-story';
import { PrimitivesStory } from './primitives-story';

const componentTabs = [
  { value: 'actions', label: 'Actions' },
  { value: 'forms', label: 'Forms' },
  { value: 'feedback', label: 'Feedback' },
  { value: 'media', label: 'Media & tables' },
  { value: 'overlays', label: 'Overlays' },
  { value: 'data', label: 'Data' },
  { value: 'motion', label: 'Motion' },
];

export function ComponentsStory() {
  return (
    <Tabs defaultValue='actions' className='gap-5'>
      <div className='overflow-x-auto overscroll-x-contain pb-1'>
        <TabsList className='min-w-max'>
          {componentTabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value='actions'>
        <PrimitivesStory category='actions' />
      </TabsContent>
      <TabsContent value='forms'>
        <PrimitivesStory category='forms' />
      </TabsContent>
      <TabsContent value='feedback'>
        <PrimitivesStory category='feedback' />
      </TabsContent>
      <TabsContent value='media'>
        <PrimitivesStory category='media' />
      </TabsContent>
      <TabsContent value='overlays'>
        <OverlaysStory />
      </TabsContent>
      <TabsContent value='data'>
        <DataStory />
      </TabsContent>
      <TabsContent value='motion'>
        <MotionStory />
      </TabsContent>
    </Tabs>
  );
}
