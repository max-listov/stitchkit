'use client';

import { IconChevronLeft, IconChevronRight, IconSearch } from '@tabler/icons-react';
import {
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnVisibilityState,
  type OnChangeFn,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  useTable,
} from '@tanstack/react-table';
import { type ReactNode, useId, useMemo, useState } from 'react';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { dataTableFeatures } from '../table-features';

interface DataTableProps<TData extends object> {
  columns: ColumnDef<typeof dataTableFeatures, TData, unknown>[];
  data: TData[];
  searchKey?: string;
  searchPlaceholder?: string;
  actions?: ReactNode;
  isLoading?: boolean;
  isFetching?: boolean;
  pageCount?: number;
  totalCount?: number;
  manualPagination?: boolean;
  manualSorting?: boolean;
  sorting?: SortingState;
  pagination?: PaginationState;
  search?: string;
  onPaginationChange?: OnChangeFn<PaginationState>;
  onSortingChange?: OnChangeFn<SortingState>;
  onSearchChange?: (search: string) => void;
}

interface PaginationItem {
  id: string;
  page?: number;
}

function paginationItems(currentPage: number, totalPages: number): PaginationItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, page) => ({ id: `page-${page}`, page }));
  }
  const pages: PaginationItem[] = [{ id: 'page-0', page: 0 }];
  if (currentPage > 2) pages.push({ id: 'ellipsis-left' });
  for (
    let index = Math.max(1, currentPage - 1);
    index <= Math.min(totalPages - 2, currentPage + 1);
    index++
  ) {
    pages.push({ id: `page-${index}`, page: index });
  }
  if (currentPage < totalPages - 3) pages.push({ id: 'ellipsis-right' });
  pages.push({ id: `page-${totalPages - 1}`, page: totalPages - 1 });
  return pages;
}

export function DataTable<TData extends object>({
  columns,
  data,
  searchKey,
  searchPlaceholder = 'Search…',
  actions,
  isLoading = false,
  isFetching = false,
  pageCount,
  totalCount,
  manualPagination = false,
  manualSorting = false,
  sorting: sortingProp,
  pagination: paginationProp,
  search: searchProp,
  onPaginationChange,
  onSortingChange,
  onSearchChange,
}: DataTableProps<TData>) {
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({});
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [internalSorting, setInternalSorting] = useState<SortingState>([]);
  const [internalPagination, setInternalPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  });
  const [internalSearch, setInternalSearch] = useState('');

  const sorting = sortingProp ?? internalSorting;
  const pagination = paginationProp ?? internalPagination;
  const skeletonRootId = useId();
  const skeletonRows = useMemo(
    () =>
      Array.from({ length: pagination.pageSize }, (_, position) => ({
        id: `${skeletonRootId}-row-${position}`,
        cells: columns.map(
          (_, cellPosition) => `${skeletonRootId}-${position}-${cellPosition}`,
        ),
      })),
    [columns, pagination.pageSize, skeletonRootId],
  );
  const searchValue = searchProp ?? internalSearch;
  const isServerSide = manualPagination;
  const table = useTable(
    {
      features: dataTableFeatures,
      data,
      columns,
      pageCount,
      manualPagination,
      manualSorting,
      manualFiltering: isServerSide,
      enableSortingRemoval: false,
      onSortingChange: onSortingChange ?? setInternalSorting,
      onPaginationChange: onPaginationChange ?? setInternalPagination,
      onColumnFiltersChange: setColumnFilters,
      onColumnVisibilityChange: setColumnVisibility,
      onRowSelectionChange: setRowSelection,
      state: { sorting, columnFilters, columnVisibility, rowSelection, pagination },
    },
    (state) => state,
  );

  function handleSearchChange(value: string): void {
    if (!isServerSide) {
      setInternalSearch(value);
      if (searchKey) table.getColumn(searchKey)?.setFilterValue(value);
    }
    onSearchChange?.(value);
  }

  const selectedCount = table.getFilteredSelectedRowModel().rows.length;
  const displayedCount = isServerSide
    ? (totalCount ?? data.length)
    : table.getFilteredRowModel().rows.length;
  const currentPage = table.state.pagination.pageIndex;
  const totalPages = table.getPageCount();

  return (
    <div className='flex h-full flex-col'>
      {(onSearchChange || searchKey || actions) && (
        <div className='flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4 py-3'>
          {onSearchChange || searchKey ? (
            <div className='relative max-w-xs flex-1'>
              <IconSearch className='absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground' />
              <Input
                className='h-8 pl-8 text-sm'
                placeholder={searchPlaceholder}
                value={searchValue}
                onChange={(event) => handleSearchChange(event.target.value)}
              />
            </div>
          ) : (
            <div />
          )}
          {actions && <div className='flex items-center gap-2'>{actions}</div>}
        </div>
      )}

      <div
        className={`flex-1 overflow-auto transition-opacity ${isFetching ? 'opacity-50' : ''}`}
      >
        <Table>
          <TableHeader className='sticky top-0 z-10 bg-background'>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow
                key={headerGroup.id}
                className='border-b border-border hover:bg-transparent'
              >
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className='h-10 whitespace-nowrap bg-background text-xs font-medium'
                  >
                    {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              skeletonRows.map((row) => (
                <TableRow key={row.id}>
                  {row.cells.map((cellId) => (
                    <TableCell key={cellId} className='h-12 py-2'>
                      <Skeleton className='h-4 w-28' />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className='h-12 py-2'>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className='h-24 text-center text-sm text-muted-foreground'
                >
                  No results
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className='flex h-11 shrink-0 items-center justify-between border-t border-border bg-background px-4'>
        <div className='flex items-center gap-4'>
          <span className='text-xs text-muted-foreground'>
            {selectedCount > 0
              ? `${selectedCount} of ${displayedCount} selected`
              : `${displayedCount} projects`}
          </span>
          <Select
            value={String(table.state.pagination.pageSize)}
            onValueChange={(value) => table.setPageSize(Number(value))}
          >
            <SelectTrigger
              aria-label='Rows per page'
              variant='ghost'
              className='h-7 w-fit rounded px-2 text-xs'
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[10, 20, 50, 100].map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className='flex items-center gap-0.5'>
          <Button
            aria-label='Previous page'
            variant='ghost'
            size='icon'
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <IconChevronLeft size={14} />
          </Button>
          {paginationItems(currentPage, totalPages).map((item) => {
            if (item.page === undefined) {
              return (
                <span key={item.id} className='px-1 text-xs text-muted-foreground'>
                  …
                </span>
              );
            }
            const page = item.page;
            return (
              <Button
                key={item.id}
                aria-label={`Go to page ${page + 1}`}
                variant={currentPage === page ? 'default' : 'ghost'}
                size='icon'
                onClick={() => table.setPageIndex(page)}
              >
                {page + 1}
              </Button>
            );
          })}
          <Button
            aria-label='Next page'
            variant='ghost'
            size='icon'
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            <IconChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}
