'use client';

import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

const DEFAULT_ITEM_HEIGHT = 36; // h-9

interface SlotDrumProps<T> {
  items: T[];
  activeIndex: number;
  renderItem: (item: T, index: number) => ReactNode;
  getItemKey: (item: T) => string;
  itemHeight?: number;
  className?: string;
}

export function SlotDrum<T>({
  items,
  activeIndex,
  renderItem,
  getItemKey,
  itemHeight = DEFAULT_ITEM_HEIGHT,
  className,
}: SlotDrumProps<T>) {
  return (
    <div
      className={`relative overflow-hidden ${className ?? ''}`}
      style={{ height: itemHeight }}
    >
      <motion.div
        animate={{ y: -activeIndex * itemHeight }}
        transition={{
          type: 'spring',
          stiffness: 300,
          damping: 30,
        }}
      >
        {items.map((item, index) => (
          <div
            key={getItemKey(item)}
            className='flex items-center'
            style={{ height: itemHeight }}
          >
            {renderItem(item, index)}
          </div>
        ))}
      </motion.div>
    </div>
  );
}
