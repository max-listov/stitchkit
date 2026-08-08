import { useCallback, useEffect, useRef } from 'react';

interface UseInfiniteScrollOptions {
  /** Функция загрузки следующей страницы */
  fetchNextPage: () => void;
  /** Есть ли ещё страницы */
  hasNextPage: boolean;
  /** Идёт ли загрузка */
  isFetchingNextPage: boolean;
  /** Отступ от края для срабатывания (default: 100px) */
  rootMargin?: string;
  /** Порог срабатывания (default: 0) */
  threshold?: number;
}

/**
 * Хук для infinite scroll с IntersectionObserver
 *
 * @example
 * const { loadMoreRef } = useInfiniteScroll({
 *   fetchNextPage,
 *   hasNextPage,
 *   isFetchingNextPage,
 * });
 *
 * return (
 *   <div>
 *     {items.map(...)}
 *     <div ref={loadMoreRef} />
 *   </div>
 * );
 */
export function useInfiniteScroll({
  fetchNextPage,
  hasNextPage,
  isFetchingNextPage,
  rootMargin = '100px',
  threshold = 0,
}: UseInfiniteScrollOptions) {
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const handleObserver = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const [entry] = entries;
      if (entry?.isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage],
  );

  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(handleObserver, {
      root: null,
      rootMargin,
      threshold,
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [handleObserver, rootMargin, threshold]);

  return { loadMoreRef };
}
