'use client';

import {
  IconArrowUpRight,
  IconBrandGithub,
  IconGitCommit,
  IconRefresh,
  IconStar,
} from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { Button, Skeleton } from '@/components/ui';
import { useRefreshRepository, useRepository } from '@/lib/api/queries';

function RepositorySkeleton() {
  return (
    <div className='mx-auto flex w-full max-w-4xl items-center gap-4 rounded-xl border border-border bg-card px-4 py-4'>
      <Skeleton className='size-10 shrink-0 rounded-xl' />
      <div className='flex-1 space-y-2'>
        <Skeleton className='h-4 w-44' />
        <Skeleton className='h-3 w-64 max-w-full' />
      </div>
      <Skeleton className='hidden h-8 w-52 sm:block' />
    </div>
  );
}

export function RepositorySummary() {
  const locale = useLocale();
  const queryClient = useQueryClient();
  const repository = useRepository();
  const refresh = useRefreshRepository({
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: useRepository.getKey() });
    },
  });

  if (repository.isLoading) return <RepositorySkeleton />;
  if (repository.isError || !repository.data) {
    return (
      <div className='mx-auto w-full max-w-4xl rounded-xl border border-border bg-card px-4 py-4 text-sm text-muted-foreground'>
        Repository data is unavailable. Check the API connection and retry.
      </div>
    );
  }

  const snapshot = repository.data;
  const commitDate = snapshot.latestCommit
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
        new Date(snapshot.latestCommit.committedAt),
      )
    : '—';

  return (
    <div className='mx-auto flex w-full max-w-4xl flex-col gap-4 rounded-xl border border-border bg-card/80 px-4 py-4 text-left backdrop-blur sm:flex-row sm:items-center sm:px-5'>
      <a
        className='group flex min-w-0 flex-1 items-center gap-3'
        href={snapshot.htmlUrl}
        rel='noreferrer'
        target='_blank'
      >
        <span className='flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background'>
          <IconBrandGithub size={21} />
        </span>
        <span className='min-w-0'>
          <span className='flex min-w-0 items-center gap-2 font-medium'>
            <span className='truncate'>{snapshot.fullName}</span>
            <IconArrowUpRight
              className='shrink-0 opacity-50 group-hover:opacity-100'
              size={16}
            />
          </span>
          <span className='mt-1 block truncate text-xs text-muted-foreground'>
            Live backend query · {snapshot.visibility} · {snapshot.language}
          </span>
        </span>
      </a>

      <div className='flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground sm:justify-end'>
        <span className='flex items-center gap-1.5' title='Commits'>
          <IconGitCommit size={16} />
          <span className='font-medium text-foreground'>
            {snapshot.commitCount.toLocaleString(locale)}
          </span>
        </span>
        <span className='flex items-center gap-1.5' title='Stars'>
          <IconStar size={16} />
          <span className='font-medium text-foreground'>
            {snapshot.stars.toLocaleString(locale)}
          </span>
        </span>
        <span className='whitespace-nowrap text-xs'>{commitDate}</span>
        <Button
          aria-label='Refresh repository data'
          aria-busy={refresh.isPending || undefined}
          className='shrink-0 disabled:opacity-100'
          disabled={refresh.isPending}
          onClick={() => refresh.mutate(undefined)}
          size='icon'
          variant='outline'
        >
          <IconRefresh className={refresh.isPending ? 'animate-spin' : undefined} size={18} />
        </Button>
      </div>
    </div>
  );
}
