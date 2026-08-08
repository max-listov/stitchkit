'use client';

import { useState } from 'react';
import {
  AnimatedCounter,
  Button,
  Card,
  CardContent,
  CardDeck,
  CardHeader,
  CardTitle,
  SlotDrum,
} from '@/components/ui';
import { StorySection } from './catalogue-shell';

const deckItems = [
  { title: 'Contracts', copy: 'One source of truth' },
  { title: 'Transport', copy: 'HTTP, MCP and agents' },
  { title: 'Interface', copy: 'Typed data to polished UI' },
];
const stages = ['Idea', 'Building', 'Shipping'];

export function MotionStory() {
  const [count, setCount] = useState(24);
  const [stage, setStage] = useState(0);
  return (
    <div>
      <StorySection title='Meaningful motion'>
        <div className='grid gap-4 md:grid-cols-2'>
          <Card>
            <CardHeader>
              <CardTitle>Delivery count</CardTitle>
            </CardHeader>
            <CardContent className='space-y-4'>
              <AnimatedCounter className='text-4xl font-medium' value={count} suffix='%' />
              <Button onClick={() => setCount((value) => (value + 13) % 101)}>Advance</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Current stage</CardTitle>
            </CardHeader>
            <CardContent className='space-y-4'>
              <SlotDrum
                className='text-2xl font-medium'
                items={stages}
                activeIndex={stage}
                getItemKey={(item) => item}
                renderItem={(item) => item}
              />
              <Button onClick={() => setStage((value) => (value + 1) % stages.length)}>
                Next stage
              </Button>
            </CardContent>
          </Card>
        </div>
      </StorySection>
      <StorySection title='Composed card deck'>
        <div className='py-8'>
          <CardDeck
            items={deckItems}
            overlap={-24}
            rotationStep={4}
            keyExtractor={(item) => item.title}
            renderCard={(item) => (
              <Card className='w-52 bg-card'>
                <CardHeader>
                  <CardTitle>{item.title}</CardTitle>
                </CardHeader>
                <CardContent className='text-sm text-muted-foreground'>{item.copy}</CardContent>
              </Card>
            )}
          />
        </div>
      </StorySection>
    </div>
  );
}
