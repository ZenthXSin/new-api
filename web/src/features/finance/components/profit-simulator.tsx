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
import { Calculator, RefreshCw, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldTitle } from '@/components/ui/field'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import dayjs from '@/lib/dayjs'
import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import type { FinanceOverview } from '../api'
import {
  SIMULATION_LIMITS,
  simulateProfit,
  validateSimulationInput,
  type SimulationData,
  type SimulationInput,
} from '../lib/profit-simulation'
import { ProfitSimulationResults } from './profit-simulation-results'

interface ProfitSimulatorProps {
  overview: FinanceOverview | undefined
  rangeDays: number
  overviewLoading: boolean
  overviewError: boolean
}

function defaultSimulationInput(): SimulationInput {
  return {
    startDate: dayjs().format('YYYY-MM-DD'),
    days: 30,
    baseDailyRevenue: 100,
    marginMin: 15,
    marginMax: 35,
    revenueVolatility: 10,
    mode: 'stable',
    seed: 42,
  }
}

const NUMBER_FIELDS = [
  {
    name: 'days',
    label: 'Duration (days)',
    min: 1,
    max: SIMULATION_LIMITS.maxDays,
    step: 1,
  },
  {
    name: 'marginMin',
    label: 'Minimum profit margin (%)',
    min: SIMULATION_LIMITS.minMargin,
    max: SIMULATION_LIMITS.maxMargin,
    step: 0.1,
  },
  {
    name: 'marginMax',
    label: 'Maximum profit margin (%)',
    min: SIMULATION_LIMITS.minMargin,
    max: SIMULATION_LIMITS.maxMargin,
    step: 0.1,
  },
  {
    name: 'revenueVolatility',
    label: 'Revenue fluctuation (%)',
    min: 0,
    max: SIMULATION_LIMITS.maxRevenueVolatility,
    step: 1,
  },
  {
    name: 'seed',
    label: 'Random Seed',
    min: 0,
    max: SIMULATION_LIMITS.maxSeed,
    step: 1,
  },
] as const

export function ProfitSimulator(props: ProfitSimulatorProps) {
  const { t } = useTranslation()
  const quotaPerUnit = useSystemConfigStore(
    (state) => state.config.currency.quotaPerUnit
  )
  const [source, setSource] = useState<'manual' | 'actual'>('manual')
  const [result, setResult] = useState<SimulationData | null>(null)
  const [submittedInput, setSubmittedInput] = useState<SimulationInput | null>(
    null
  )
  const schema = useMemo(
    () =>
      z
        .object({
          startDate: z.string(),
          days: z.number({ error: t('Enter a valid number') }),
          baseDailyRevenue: z.number({ error: t('Enter a valid number') }),
          marginMin: z.number({ error: t('Enter a valid number') }),
          marginMax: z.number({ error: t('Enter a valid number') }),
          revenueVolatility: z.number({ error: t('Enter a valid number') }),
          mode: z.enum(['stable', 'random', 'cycle']),
          seed: z.number({ error: t('Enter a valid number') }),
        })
        .superRefine((value, context) => {
          for (const [field, message] of Object.entries(
            validateSimulationInput(value)
          )) {
            context.addIssue({
              code: 'custom',
              path: [field],
              message: t(message),
            })
          }
        }),
    [t]
  )
  const form = useForm<SimulationInput>({
    resolver: zodResolver(schema),
    defaultValues: defaultSimulationInput(),
  })
  const values = useWatch({ control: form.control })
  const resultsOutdated =
    submittedInput !== null &&
    JSON.stringify(values) !== JSON.stringify(submittedInput)
  const realRevenue = props.overview?.revenue_quota
  const actualAvailable =
    !props.overviewLoading &&
    !props.overviewError &&
    typeof realRevenue === 'number' &&
    Number.isFinite(realRevenue) &&
    realRevenue >= 0 &&
    props.rangeDays > 0
  const actualDailyRevenue = actualAvailable
    ? realRevenue /
      (quotaPerUnit > 0 ? quotaPerUnit : DEFAULT_CURRENCY_CONFIG.quotaPerUnit) /
      props.rangeDays
    : 0
  const actualUnavailable = source === 'actual' && !actualAvailable
  useEffect(() => {
    if (source === 'actual' && actualAvailable) {
      form.setValue(
        'baseDailyRevenue',
        Math.round(actualDailyRevenue * 100) / 100,
        { shouldValidate: true }
      )
    }
  }, [actualAvailable, actualDailyRevenue, form, source])
  const modes = [
    {
      value: 'stable',
      label: t('Smooth'),
      description: t('Smooth changes between the margin bounds.'),
    },
    {
      value: 'random',
      label: t('Random'),
      description: t('Independent daily margins within the bounds.'),
    },
    {
      value: 'cycle',
      label: t('Cyclic'),
      description: t(
        'Margins follow a repeating 28-day cycle within the bounds.'
      ),
    },
  ] as const

  const run = (input: SimulationInput) => {
    if (actualUnavailable) return
    const outcome = simulateProfit(input)
    if (!outcome.success) {
      for (const [field, message] of Object.entries(outcome.errors)) {
        form.setError(field as keyof SimulationInput, { message: t(message) })
      }
      return
    }
    setSubmittedInput({ ...input })
    setResult(outcome.data)
  }

  const newScenario = () => {
    const seed = form.getValues('seed')
    form.setValue(
      'seed',
      Number.isInteger(seed) && seed >= 0 && seed < SIMULATION_LIMITS.maxSeed
        ? seed + 1
        : 0
    )
    void form.handleSubmit(run)()
  }

  const reset = () => {
    form.reset(defaultSimulationInput())
    setSource('manual')
    setSubmittedInput(null)
    setResult(null)
  }

  return (
    <div className='space-y-4 pb-3'>
      <p className='bg-muted/50 text-muted-foreground rounded-lg border p-3 text-sm'>
        {t(
          'Simulation only. Results do not change real balances, bills, or profit reports.'
        )}
      </p>
      <Card>
        <CardHeader>
          <CardTitle>{t('Simulation Settings')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(run)}
              noValidate
              className='space-y-5'
            >
              <Field>
                <FieldTitle id='simulation-revenue-source'>
                  {t('Revenue Source')}
                </FieldTitle>
                <ToggleGroup
                  aria-labelledby='simulation-revenue-source'
                  value={[source]}
                  onValueChange={(selection) => {
                    const value = selection.at(-1)
                    if (value === 'manual') setSource('manual')
                    if (value === 'actual' && actualAvailable) {
                      setSource('actual')
                      form.setValue(
                        'baseDailyRevenue',
                        Math.round(actualDailyRevenue * 100) / 100,
                        { shouldValidate: true }
                      )
                    }
                  }}
                  variant='outline'
                  className='max-w-full flex-wrap'
                >
                  <ToggleGroupItem value='manual'>
                    {t('Manual daily revenue')}
                  </ToggleGroupItem>
                  <ToggleGroupItem value='actual' disabled={!actualAvailable}>
                    {t('Use actual daily average')}
                  </ToggleGroupItem>
                </ToggleGroup>
                <p className='text-muted-foreground text-xs'>
                  {actualAvailable
                    ? t(
                        'Based on revenue from the selected {{days}}-day finance window.',
                        { days: props.rangeDays }
                      )
                    : t(
                        'Actual revenue is unavailable. Enter a daily revenue manually.'
                      )}
                </p>
              </Field>
              <FieldGroup className='grid gap-4 sm:grid-cols-2 xl:grid-cols-3'>
                <FormField
                  control={form.control}
                  name='baseDailyRevenue'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('Base daily revenue (USD)')}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type='number'
                          min={0}
                          max={SIMULATION_LIMITS.maxRevenue}
                          step={0.01}
                          readOnly={source === 'actual'}
                          value={
                            Number.isFinite(field.value) ? field.value : ''
                          }
                          onChange={(event) =>
                            field.onChange(
                              event.target.value === ''
                                ? Number.NaN
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
                  name='startDate'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('Start Date')}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type='date'
                          min='0001-01-01'
                          max='9999-12-31'
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {NUMBER_FIELDS.map((input) => (
                  <FormField
                    key={input.name}
                    control={form.control}
                    name={input.name}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t(input.label)}</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type='number'
                            min={input.min}
                            max={input.max}
                            step={input.step}
                            value={
                              Number.isFinite(field.value) ? field.value : ''
                            }
                            onChange={(event) =>
                              field.onChange(
                                event.target.value === ''
                                  ? Number.NaN
                                  : Number(event.target.value)
                              )
                            }
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ))}
                <FormField
                  control={form.control}
                  name='mode'
                  render={({ field }) => (
                    <FormItem className='sm:col-span-2'>
                      <FormLabel>{t('Fluctuation Mode')}</FormLabel>
                      <FormControl>
                        <ToggleGroup
                          value={[field.value]}
                          onValueChange={(selection) => {
                            const value = selection.at(-1)
                            if (value) field.onChange(value)
                          }}
                          variant='outline'
                          className='max-w-full flex-wrap'
                        >
                          {modes.map((mode) => (
                            <ToggleGroupItem
                              key={mode.value}
                              value={mode.value}
                            >
                              {mode.label}
                            </ToggleGroupItem>
                          ))}
                        </ToggleGroup>
                      </FormControl>
                      <FormDescription>
                        {
                          modes.find((mode) => mode.value === field.value)
                            ?.description
                        }
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </FieldGroup>
              <div className='text-muted-foreground space-y-1 text-xs'>
                <p>
                  {t(
                    'Profit margin is profit divided by revenue. Negative margins simulate a loss.'
                  )}
                </p>
                <p>
                  {t(
                    'Daily revenue varies within this percentage of the baseline.'
                  )}
                </p>
                <p>
                  {t(
                    'The same settings and seed reproduce the same simulation.'
                  )}
                </p>
              </div>
              <div className='flex flex-wrap gap-2'>
                <Button type='submit' disabled={actualUnavailable}>
                  <Calculator className='size-4' />
                  {t('Run Simulation')}
                </Button>
                <Button
                  type='button'
                  variant='outline'
                  onClick={newScenario}
                  disabled={actualUnavailable}
                >
                  <RefreshCw className='size-4' />
                  {t('New Random Scenario')}
                </Button>
                <Button type='button' variant='ghost' onClick={reset}>
                  <RotateCcw className='size-4' />
                  {t('Reset Simulation')}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
      {resultsOutdated && (
        <p
          role='status'
          className='text-muted-foreground rounded-lg border p-3 text-sm'
        >
          {t(
            'Simulation parameters have changed. Run again to update the results.'
          )}
        </p>
      )}
      {result && submittedInput ? (
        <ProfitSimulationResults
          key={JSON.stringify(submittedInput)}
          data={result}
          startDate={submittedInput.startDate}
        />
      ) : (
        <EmptyState
          title={t('No simulation yet')}
          description={t('Choose your assumptions and run a simulation.')}
        />
      )}
    </div>
  )
}
