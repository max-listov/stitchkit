'use client';

import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';

interface AnimatedCounterProps {
  value: number;
  suffix?: string;
  className?: string;
  itemHeight?: number;
}

/**
 * Анимированный счётчик с эффектом барабана
 */
export function AnimatedCounter({
  value,
  suffix = '',
  className,
  itemHeight = 48,
}: AnimatedCounterProps) {
  const prevValueRef = useRef(value);
  const [animationKey, setAnimationKey] = useState(0);
  const [items, setItems] = useState<number[]>([value]);
  const [startY, setStartY] = useState(0);
  const [endY, setEndY] = useState(0);

  useEffect(() => {
    const prevValue = prevValueRef.current;
    if (prevValue === value) return;

    // Генерируем диапазон от большего к меньшему (сверху вниз)
    const min = Math.min(prevValue, value);
    const max = Math.max(prevValue, value);
    const range: number[] = [];
    for (let i = max; i >= min; i--) {
      range.push(i);
    }

    const prevIndex = range.indexOf(prevValue);
    const nextIndex = range.indexOf(value);

    setItems(range);
    setStartY(-prevIndex * itemHeight);
    setEndY(-nextIndex * itemHeight);
    setAnimationKey((k) => k + 1);

    prevValueRef.current = value;
  }, [value, itemHeight]);

  return (
    <div
      className={`relative overflow-hidden ${className ?? ''}`}
      style={{ height: itemHeight }}
    >
      <motion.div
        key={animationKey}
        initial={{ y: startY }}
        animate={{ y: endY }}
        transition={{
          type: 'spring',
          stiffness: 200,
          damping: 20,
          mass: 0.8,
        }}
      >
        {items.map((num) => (
          <div
            key={num}
            className='flex items-center justify-center'
            style={{ height: itemHeight }}
          >
            {num}
            {suffix}
          </div>
        ))}
      </motion.div>
    </div>
  );
}
