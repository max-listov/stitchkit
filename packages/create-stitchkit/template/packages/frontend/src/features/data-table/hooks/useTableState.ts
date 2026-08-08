'use client';

import type { OnChangeFn, PaginationState, SortingState } from '@tanstack/react-table';
import { useCallback, useMemo, useState } from 'react';

export interface UseTableStateOptions {
  defaultSort?: string;
  defaultSortOrder?: 'asc' | 'desc';
  defaultPageSize?: number;
  defaultSearch?: string;
}

export interface TableQueryParams {
  page: number;
  limit: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  search?: string;
}

export interface TableProps {
  sorting: SortingState;
  pagination: PaginationState;
  search: string;
  onSortingChange: OnChangeFn<SortingState>;
  onPaginationChange: OnChangeFn<PaginationState>;
  onSearchChange: (search: string) => void;
  manualPagination: true;
  manualSorting: true;
}

export interface UseTableStateReturn {
  // State values
  search: string;
  pagination: PaginationState;
  sorting: SortingState;

  // Setters
  setSearch: (value: string) => void;
  setPagination: OnChangeFn<PaginationState>;
  setSorting: OnChangeFn<SortingState>;

  // Handler that resets to page 0 on search
  handleSearchChange: (value: string) => void;

  // Ready-to-use query params for API calls
  queryParams: TableQueryParams;

  // Props to spread directly to DataTable
  tableProps: TableProps;
}

export function useTableState(options: UseTableStateOptions = {}): UseTableStateReturn {
  const {
    defaultSort = 'createdAt',
    defaultSortOrder = 'desc',
    defaultPageSize = 20,
    defaultSearch = '',
  } = options;

  const [search, setSearch] = useState(defaultSearch);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: defaultPageSize,
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: defaultSort, desc: defaultSortOrder === 'desc' },
  ]);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  }, []);

  const queryParams = useMemo<TableQueryParams>(
    () => ({
      page: pagination.pageIndex + 1,
      limit: pagination.pageSize,
      sortBy: sorting[0]?.id ?? defaultSort,
      sortOrder: sorting[0]?.desc ? 'desc' : 'asc',
      search: search || undefined,
    }),
    [pagination, sorting, search, defaultSort],
  );

  const tableProps = useMemo<TableProps>(
    () => ({
      sorting,
      pagination,
      search,
      onSortingChange: setSorting,
      onPaginationChange: setPagination,
      onSearchChange: handleSearchChange,
      manualPagination: true,
      manualSorting: true,
    }),
    [sorting, pagination, search, handleSearchChange],
  );

  return {
    search,
    pagination,
    sorting,
    setSearch,
    setPagination,
    setSorting,
    handleSearchChange,
    queryParams,
    tableProps,
  };
}
