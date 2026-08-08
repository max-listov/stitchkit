'use client';

import type { ReactNode } from 'react';

export interface CardDeckProps<T> {
  /** Массив элементов для отображения */
  items: T[];
  /** Рендер-функция для каждой карточки */
  renderCard: (item: T, index: number) => ReactNode;
  /** Отступ между картами в px (отрицательный для наложения) @default -10 */
  overlap?: number;
  /** Шаг наклона в градусах @default 3 */
  rotationStep?: number;
  /** Индекс центральной карты (по умолчанию — середина массива) */
  centerIndex?: number;
  /** Дополнительные классы для контейнера */
  className?: string;
  /** Уникальный ключ для элемента */
  keyExtractor?: (item: T, index: number) => string | number;
}

/**
 * Универсальный компонент "колода карт" с эффектом веера.
 *
 * Автоматически рассчитывает наклон каждой карты относительно центра.
 * Карты накладываются друг на друга с заданным overlap.
 *
 * @example
 * ```tsx
 * <CardDeck
 *   items={projects}
 *   renderCard={(project) => <ProjectCard project={project} />}
 *   overlap={-12}
 *   rotationStep={4}
 * />
 * ```
 */
export function CardDeck<T>({
  items,
  renderCard,
  overlap = -10,
  rotationStep = 3,
  centerIndex,
  className,
  keyExtractor,
}: CardDeckProps<T>) {
  // Центр по умолчанию — середина массива
  const center = centerIndex ?? Math.floor((items.length - 1) / 2);

  return (
    <div className={`flex justify-center ${className ?? ''}`}>
      {items.map((item, index) => {
        const rotation = (index - center) * rotationStep;
        const key = keyExtractor ? keyExtractor(item, index) : index;

        return (
          <div
            key={key}
            className='shrink-0 cursor-pointer group'
            style={{ marginLeft: index === 0 ? 0 : overlap }}
          >
            <div
              className='relative transition-[filter,opacity] duration-200 ease-in-out group-hover:z-50 group-hover:brightness-105'
              style={{ transform: `rotate(${rotation}deg)` }}
            >
              {renderCard(item, index)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
