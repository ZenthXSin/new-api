/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef, PaginationState } from '@tanstack/react-table'
import type { TFunction } from 'i18next'
import { Edit, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'

import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  DataTablePage,
  TruncatedCell,
  useDataTable,
} from '@/components/data-table'
import { DatePicker } from '@/components/date-picker'
import { StatusBadge, type StatusVariant } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

import {
  createFinanceEntry,
  deleteFinanceEntry,
  getFinanceEntries,
  updateFinanceEntry,
  type FinanceEntryItem,
  type FinanceEntryType,
} from '../api'
import { formatMoney, formatTimestamp } from '../lib/format'

const ALL_TYPES = 'all'

const ENTRY_TYPES: FinanceEntryType[] = ['income', 'expense']

const ENTRY_TYPE_BADGE_VARIANTS: Record<FinanceEntryType, StatusVariant> = {
  income: 'success',
  expense: 'danger',
}

const ENTRY_TYPE_LABELS: Record<FinanceEntryType, string> = {
  income: 'Income',
  expense: 'Expense',
}

function createEntryFormSchema(t: TFunction) {
  return z.object({
    entry_type: z.enum(['income', 'expense']),
    category: z
      .string()
      .trim()
      .min(1, t('Category name is required'))
      .max(50, t('Category name must be less than 50 characters')),
    amount: z.number().positive(t('Amount must be greater than 0')),
    note: z.string().max(500, t('Note must not exceed 500 characters')),
  })
}

type EntryFormValues = {
  entry_type: FinanceEntryType
  category: string
  amount: number
  note: string
}

function toSeconds(date: Date | undefined): number | undefined {
  return date ? Math.floor(date.getTime() / 1000) : undefined
}

export function EntriesTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  })
  const [entryType, setEntryType] = useState<string>(ALL_TYPES)
  const [startDate, setStartDate] = useState<Date | undefined>(undefined)
  const [endDate, setEndDate] = useState<Date | undefined>(undefined)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingEntry, setEditingEntry] = useState<FinanceEntryItem | null>(
    null
  )
  const [deletingEntry, setDeletingEntry] = useState<FinanceEntryItem | null>(
    null
  )
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const start = toSeconds(startDate)
  const end = toSeconds(endDate)

  const entrySchema = useMemo(() => createEntryFormSchema(t), [t])
  const resolver = useMemo(() => zodResolver(entrySchema), [entrySchema])
  const form = useForm<EntryFormValues>({
    resolver,
    defaultValues: { entry_type: 'income', category: '', amount: 0, note: '' },
  })

  useEffect(() => {
    if (!dialogOpen) return
    form.reset(
      editingEntry
        ? {
            entry_type: editingEntry.entry_type,
            category: editingEntry.category,
            amount: editingEntry.amount,
            note: editingEntry.note,
          }
        : { entry_type: 'income', category: '', amount: 0, note: '' }
    )
  }, [dialogOpen, editingEntry, form])

  const resetPage = () =>
    setPagination((current) => ({ ...current, pageIndex: 0 }))

  const { data, isLoading, isFetching } = useQuery({
    queryKey: [
      'finance-entries',
      pagination.pageIndex,
      pagination.pageSize,
      entryType,
      start,
      end,
    ],
    queryFn: () =>
      getFinanceEntries({
        page: pagination.pageIndex + 1,
        size: pagination.pageSize,
        entry_type:
          entryType === ALL_TYPES ? undefined : (entryType as FinanceEntryType),
        start,
        end,
      }),
    placeholderData: (previous) => previous,
  })

  const refreshEntries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['finance-entries'] })
  }, [queryClient])

  const openCreate = useCallback(() => {
    setEditingEntry(null)
    setDialogOpen(true)
  }, [])

  const openEdit = useCallback((entry: FinanceEntryItem) => {
    setEditingEntry(entry)
    setDialogOpen(true)
  }, [])

  const openDelete = useCallback((entry: FinanceEntryItem) => {
    setDeletingEntry(entry)
  }, [])

  const columns = useMemo<ColumnDef<FinanceEntryItem>[]>(
    () => [
      {
        accessorKey: 'id',
        header: t('ID'),
        cell: ({ row }) => row.original.id,
        meta: { mobileHidden: true },
      },
      {
        accessorKey: 'entry_type',
        header: t('Entry Type'),
        cell: ({ row }) => (
          <StatusBadge
            label={t(ENTRY_TYPE_LABELS[row.original.entry_type])}
            variant={ENTRY_TYPE_BADGE_VARIANTS[row.original.entry_type]}
            copyable={false}
          />
        ),
        meta: { mobileBadge: true },
      },
      {
        accessorKey: 'category',
        header: t('Category'),
        cell: ({ row }) => row.original.category || '-',
        meta: { mobileTitle: true },
      },
      {
        accessorKey: 'amount',
        header: t('Amount'),
        cell: ({ row }) => `¥${formatMoney(row.original.amount)}`,
      },
      {
        accessorKey: 'note',
        header: t('Note'),
        cell: ({ row }) => (
          <TruncatedCell>{row.original.note || '-'}</TruncatedCell>
        ),
      },
      {
        accessorKey: 'created_at',
        header: t('Created At'),
        cell: ({ row }) => formatTimestamp(row.original.created_at),
      },
      {
        id: 'actions',
        header: t('Actions'),
        cell: ({ row }) => {
          const entry = row.original
          return (
            <div className='-ml-1.5 flex items-center gap-1'>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant='ghost'
                      size='icon-sm'
                      onClick={() => openEdit(entry)}
                      aria-label={t('Edit')}
                    />
                  }
                >
                  <Edit />
                </TooltipTrigger>
                <TooltipContent>{t('Edit')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant='ghost'
                      size='icon-sm'
                      onClick={() => openDelete(entry)}
                      aria-label={t('Delete')}
                      className='text-destructive hover:text-destructive'
                    />
                  }
                >
                  <Trash2 />
                </TooltipTrigger>
                <TooltipContent>{t('Delete')}</TooltipContent>
              </Tooltip>
            </div>
          )
        },
      },
    ],
    [openDelete, openEdit, t]
  )

  const { table } = useDataTable({
    data: data?.items ?? [],
    columns,
    pagination,
    onPaginationChange: setPagination,
    manualPagination: true,
    totalCount: data?.total ?? 0,
  })

  const onSubmit = async (values: EntryFormValues) => {
    setIsSubmitting(true)
    try {
      if (editingEntry) {
        await updateFinanceEntry(editingEntry.id, values)
        toast.success(t('Updated successfully'))
      } else {
        await createFinanceEntry(values)
        toast.success(t('Operation successful'))
      }
      setDialogOpen(false)
      setEditingEntry(null)
      refreshEntries()
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deletingEntry) return
    setIsDeleting(true)
    try {
      await deleteFinanceEntry(deletingEntry.id)
      toast.success(t('Deleted successfully'))
      setDeletingEntry(null)
      refreshEntries()
    } finally {
      setIsDeleting(false)
    }
  }

  const selectItems = useMemo(
    () =>
      ENTRY_TYPES.map((type) => ({
        value: type,
        label: t(ENTRY_TYPE_LABELS[type]),
      })),
    [t]
  )

  return (
    <>
      <DataTablePage
        table={table}
        columns={columns}
        isLoading={isLoading}
        isFetching={isFetching}
        emptyTitle={t('No entries yet')}
        skeletonKeyPrefix='finance-entries-skeleton'
        paginationInFooter={false}
        toolbar={
          <div className='flex flex-wrap items-center gap-2'>
            <Select
              items={selectItems}
              value={entryType}
              onValueChange={(value: string | null) => {
                setEntryType(value ?? ALL_TYPES)
                resetPage()
              }}
            >
              <SelectTrigger size='sm' className='w-36'>
                <SelectValue>
                  {entryType === ALL_TYPES
                    ? t('All Types')
                    : t(ENTRY_TYPE_LABELS[entryType as FinanceEntryType])}
                </SelectValue>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  <SelectItem value={ALL_TYPES}>{t('All Types')}</SelectItem>
                  {ENTRY_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(ENTRY_TYPE_LABELS[type])}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <DatePicker
              selected={startDate}
              onSelect={(date) => {
                setStartDate(date)
                resetPage()
              }}
              placeholder={t('Start Time')}
            />
            <DatePicker
              selected={endDate}
              onSelect={(date) => {
                setEndDate(date)
                resetPage()
              }}
              placeholder={t('End Time')}
            />
            <Button size='sm' onClick={openCreate}>
              <Plus className='size-4' aria-hidden='true' />
              {t('Add Entry')}
            </Button>
          </div>
        }
      />

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) setEditingEntry(null)
        }}
      >
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>
              {editingEntry ? t('Edit Entry') : t('Add Entry')}
            </DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form
              id='entry-form'
              onSubmit={form.handleSubmit(onSubmit)}
              className='space-y-4'
            >
              <FormField
                control={form.control}
                name='entry_type'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('Entry Type')}</FormLabel>
                    <FormControl>
                      <Select
                        items={selectItems}
                        value={field.value}
                        onValueChange={(value: string | null) => {
                          if (value === 'income' || value === 'expense') {
                            field.onChange(value)
                          }
                        }}
                      >
                        <SelectTrigger className='w-full'>
                          <SelectValue>
                            {t(ENTRY_TYPE_LABELS[field.value])}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent alignItemWithTrigger={false}>
                          <SelectGroup>
                            {ENTRY_TYPES.map((type) => (
                              <SelectItem key={type} value={type}>
                                {t(ENTRY_TYPE_LABELS[type])}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='category'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('Category')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder={t('Enter category')}
                        maxLength={50}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='amount'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('Amount')}</FormLabel>
                    <FormControl>
                      <Input
                        type='number'
                        min='0.01'
                        step='0.01'
                        placeholder='0.00'
                        value={field.value === 0 ? '' : field.value}
                        onChange={(event) =>
                          field.onChange(
                            event.target.value === ''
                              ? 0
                              : Number(event.target.value)
                          )
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='note'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('Note')}</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        placeholder={t('Enter a note')}
                        rows={3}
                        maxLength={500}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </form>
          </Form>
          <DialogFooter>
            <DialogClose render={<Button variant='outline' />}>
              {t('Cancel')}
            </DialogClose>
            <Button form='entry-form' type='submit' disabled={isSubmitting}>
              {isSubmitting ? t('Saving...') : t('Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        destructive
        open={deletingEntry !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingEntry(null)
        }}
        handleConfirm={handleDelete}
        isLoading={isDeleting}
        className='max-w-md'
        title={t('Delete entry?')}
        desc={t('This action cannot be undone.')}
        confirmText={t('Delete')}
      />
    </>
  )
}
