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
import { LockKeyhole, Plus, Trash2 } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  CloudEnvironmentCapabilities,
  CloudEnvironmentConfig,
  CloudEnvironmentVariable,
  CloudRepository,
} from '../cloud-types'
import { Button } from '../vendor/zcode/button'

type CloudConfigFieldsProps = {
  value: CloudEnvironmentConfig
  onChange: (config: CloudEnvironmentConfig) => void
  disabled?: boolean
  capabilities?: CloudEnvironmentCapabilities
}

const inputClass =
  'border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full min-w-0 rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-2 aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50'

export function CloudConfigFields(props: CloudConfigFieldsProps) {
  const { t } = useTranslation()
  const id = useId()
  const keys = useRef(new WeakMap<object, string>())
  const nextKey = useRef(0)
  const timeout = props.value.advanced.setupTimeoutSeconds
  const [timeoutDraft, setTimeoutDraft] = useState({
    value: timeout,
    text: Number.isFinite(timeout) ? String(timeout) : '',
  })
  if (!Object.is(timeoutDraft.value, timeout)) {
    setTimeoutDraft({
      value: timeout,
      text: Number.isFinite(timeout) ? String(timeout) : '',
    })
  }
  const timeoutInvalid =
    !Number.isInteger(timeout) || timeout < 60 || timeout > 1800
  const maxRepositories = props.capabilities?.limits.maxRepositories ?? 10
  const maxVariables = props.capabilities?.limits.maxEnvironmentVariables ?? 128

  function fieldKey(field: object): string {
    let key = keys.current.get(field)
    if (!key) {
      key = `${id}-${nextKey.current++}`
      keys.current.set(field, key)
    }
    return key
  }

  function updateRepository(
    repository: CloudRepository,
    patch: Partial<CloudRepository>
  ): void {
    if (props.disabled) return
    const updated = { ...repository, ...patch }
    keys.current.set(updated, fieldKey(repository))
    props.onChange({
      ...props.value,
      repositories: props.value.repositories.map((entry) =>
        entry === repository ? updated : entry
      ),
    })
  }

  function updateVariable(
    variable: CloudEnvironmentVariable,
    patch: Partial<CloudEnvironmentVariable>
  ): void {
    if (props.disabled) return
    const updated = { ...variable, ...patch }
    keys.current.set(updated, fieldKey(variable))
    props.onChange({
      ...props.value,
      environmentVariables: props.value.environmentVariables.map((entry) =>
        entry === variable ? updated : entry
      ),
    })
  }

  return (
    <fieldset disabled={props.disabled} className='min-w-0 space-y-7'>
      <legend className='sr-only'>{t('Environment configuration')}</legend>
      <section aria-labelledby={`${id}-repositories`} className='space-y-3'>
        <div className='flex items-center justify-between gap-3'>
          <h3 id={`${id}-repositories`} className='text-sm font-medium'>
            {t('Repositories')}
          </h3>
          <Button
            variant='ghost'
            className='h-8 gap-1.5 rounded-lg px-2 text-xs'
            disabled={
              props.disabled ||
              props.value.repositories.length >= maxRepositories
            }
            onClick={() =>
              props.onChange({
                ...props.value,
                repositories: [
                  ...props.value.repositories,
                  { url: '', branch: '', path: '' },
                ],
              })
            }
          >
            <Plus className='size-3.5' aria-hidden />
            {t('Add repository')}
          </Button>
        </div>
        {props.value.repositories.length === 0 && (
          <p className='text-muted-foreground text-sm'>
            {t(
              'No repositories added. Add a repository to include it in this environment.'
            )}
          </p>
        )}
        {props.value.repositories.map((repository, index) => {
          const key = fieldKey(repository)
          const path = repository.path.trim().replace(/\/+$/, '')
          const missingPath = props.value.repositories.length > 1 && !path
          const duplicatePath =
            Boolean(path) &&
            props.value.repositories.some(
              (entry) =>
                entry !== repository &&
                entry.path.trim().replace(/\/+$/, '') === path
            )
          const pathInvalid = missingPath || duplicatePath
          return (
            <fieldset
              key={key}
              className='min-w-0 space-y-3 rounded-xl border p-3'
            >
              <legend className='sr-only'>
                {t('Repository {{number}}', { number: index + 1 })}
              </legend>
              <div className='flex items-end gap-2'>
                <div className='min-w-0 flex-1 space-y-1.5'>
                  <label htmlFor={`${key}-url`} className='text-xs font-medium'>
                    {t('Repository URL')}
                  </label>
                  <input
                    id={`${key}-url`}
                    type='url'
                    value={repository.url}
                    placeholder='https://github.com/owner/repository.git'
                    className={inputClass}
                    onChange={(event) =>
                      updateRepository(repository, { url: event.target.value })
                    }
                  />
                </div>
                <Button
                  variant='ghost'
                  size='icon'
                  className='mb-0.5 size-9 rounded-lg'
                  aria-label={t('Remove repository {{number}}', {
                    number: index + 1,
                  })}
                  disabled={props.disabled}
                  onClick={() =>
                    props.onChange({
                      ...props.value,
                      repositories: props.value.repositories.filter(
                        (entry) => entry !== repository
                      ),
                    })
                  }
                >
                  <Trash2 className='size-4' aria-hidden />
                </Button>
              </div>
              <div className='grid min-w-0 gap-3 sm:grid-cols-2'>
                <div className='min-w-0 space-y-1.5'>
                  <label
                    htmlFor={`${key}-branch`}
                    className='text-xs font-medium'
                  >
                    {t('Branch')}
                  </label>
                  <input
                    id={`${key}-branch`}
                    value={repository.branch}
                    placeholder={t('Default branch')}
                    className={inputClass}
                    onChange={(event) =>
                      updateRepository(repository, {
                        branch: event.target.value,
                      })
                    }
                  />
                </div>
                <div className='min-w-0 space-y-1.5'>
                  <label
                    htmlFor={`${key}-path`}
                    className='text-xs font-medium'
                  >
                    {t('Checkout path')}
                  </label>
                  <input
                    id={`${key}-path`}
                    value={repository.path}
                    placeholder={t('Project root')}
                    className={inputClass}
                    aria-invalid={pathInvalid || undefined}
                    aria-describedby={
                      pathInvalid ? `${key}-path-error` : undefined
                    }
                    onChange={(event) =>
                      updateRepository(repository, { path: event.target.value })
                    }
                  />
                  {pathInvalid && (
                    <p
                      id={`${key}-path-error`}
                      className='text-destructive text-xs'
                    >
                      {missingPath
                        ? t(
                            'Set a checkout path for each repository when using multiple repositories.'
                          )
                        : t('Each repository needs a unique checkout path.')}
                    </p>
                  )}
                </div>
              </div>
            </fieldset>
          )
        })}
        {props.value.repositories.length >= maxRepositories && (
          <p className='text-muted-foreground text-xs'>
            {t('This environment supports up to {{count}} repositories.', {
              count: maxRepositories,
            })}
          </p>
        )}
      </section>

      <section className='space-y-2'>
        <label htmlFor={`${id}-install`} className='text-sm font-medium'>
          {t('Install script')}
        </label>
        <p
          id={`${id}-install-help`}
          className='text-muted-foreground text-xs leading-5'
        >
          {t(
            'Run commands to prepare dependencies before publishing the environment. Install tools in the project or your home directory; the container root filesystem is read-only.'
          )}
        </p>
        <textarea
          id={`${id}-install`}
          value={props.value.installScript}
          rows={5}
          spellCheck={false}
          aria-describedby={`${id}-install-help`}
          className={`${inputClass} resize-y font-mono text-xs leading-6`}
          placeholder={t('Enter setup commands')}
          onChange={(event) =>
            props.onChange({
              ...props.value,
              installScript: event.target.value,
            })
          }
        />
        {props.capabilities?.unsupportedReasons.systemPackageInstall && (
          <p className='text-muted-foreground text-xs leading-5'>
            {t(props.capabilities.unsupportedReasons.systemPackageInstall)}
          </p>
        )}
      </section>

      <section className='space-y-2'>
        <label htmlFor={`${id}-start`} className='text-sm font-medium'>
          {t('Start skill')}
        </label>
        <p
          id={`${id}-start-help`}
          className='text-muted-foreground text-xs leading-5'
        >
          {t(
            'Instructions Codex receives when starting a task in this environment.'
          )}
        </p>
        <textarea
          id={`${id}-start`}
          value={props.value.startSkill}
          rows={4}
          aria-describedby={`${id}-start-help`}
          className={`${inputClass} resize-y leading-6`}
          placeholder={t('Describe how Codex should work in this environment')}
          onChange={(event) =>
            props.onChange({ ...props.value, startSkill: event.target.value })
          }
        />
      </section>

      <section aria-labelledby={`${id}-internet`} className='space-y-2'>
        <div className='flex items-center justify-between gap-3'>
          <h3 id={`${id}-internet`} className='text-sm font-medium'>
            {t('Internet access')}
          </h3>
          <span className='bg-muted rounded-full px-2.5 py-1 text-xs'>
            {t('Enabled')}
          </span>
        </div>
        <p className='text-muted-foreground text-xs leading-5'>
          {t(
            props.capabilities?.unsupportedReasons.internetAccess ||
              'This Docker runtime provides internet access. Restricted domains and offline mode are not available.'
          )}
        </p>
      </section>

      <section aria-labelledby={`${id}-network-secrets`} className='space-y-2'>
        <div className='flex items-center justify-between gap-3'>
          <h3 id={`${id}-network-secrets`} className='text-sm font-medium'>
            {t('Network secrets')}
          </h3>
          <span className='text-muted-foreground text-xs'>
            {t('Unavailable')}
          </span>
        </div>
        <p className='text-muted-foreground text-xs leading-5'>
          {t(
            props.capabilities?.unsupportedReasons.networkSecrets ||
              'This Docker runtime does not provide a domain-scoped secret proxy. Use environment variables for secrets required by your tools.'
          )}
        </p>
      </section>

      <section aria-labelledby={`${id}-variables`} className='space-y-3'>
        <div className='flex items-center justify-between gap-3'>
          <h3 id={`${id}-variables`} className='text-sm font-medium'>
            {t('Environment variables')}
          </h3>
          <Button
            variant='ghost'
            className='h-8 gap-1.5 rounded-lg px-2 text-xs'
            disabled={
              props.disabled ||
              props.value.environmentVariables.length >= maxVariables
            }
            onClick={() =>
              props.onChange({
                ...props.value,
                environmentVariables: [
                  ...props.value.environmentVariables,
                  { name: '', value: '', secret: false, hasValue: false },
                ],
              })
            }
          >
            <Plus className='size-3.5' aria-hidden />
            {t('Add variable')}
          </Button>
        </div>
        {props.value.environmentVariables.length === 0 && (
          <p className='text-muted-foreground text-sm'>
            {t('No environment variables added.')}
          </p>
        )}
        {props.value.environmentVariables.map((variable, index) => {
          const key = fieldKey(variable)
          const retainedSecret =
            variable.secret && variable.hasValue && variable.value === undefined
          return (
            <fieldset
              key={key}
              className='min-w-0 space-y-3 rounded-xl border p-3'
            >
              <legend className='sr-only'>
                {t('Variable {{number}}', { number: index + 1 })}
              </legend>
              <div className='flex items-end gap-2'>
                <div className='min-w-0 flex-1 space-y-1.5'>
                  <label
                    htmlFor={`${key}-name`}
                    className='text-xs font-medium'
                  >
                    {t('Variable name')}
                  </label>
                  <input
                    id={`${key}-name`}
                    value={variable.name}
                    autoComplete='off'
                    spellCheck={false}
                    className={`${inputClass} font-mono`}
                    placeholder='VARIABLE_NAME'
                    onChange={(event) =>
                      updateVariable(variable, { name: event.target.value })
                    }
                  />
                </div>
                <Button
                  variant='ghost'
                  size='icon'
                  className='mb-0.5 size-9 rounded-lg'
                  aria-label={t('Remove variable {{number}}', {
                    number: index + 1,
                  })}
                  disabled={props.disabled}
                  onClick={() =>
                    props.onChange({
                      ...props.value,
                      environmentVariables:
                        props.value.environmentVariables.filter(
                          (entry) => entry !== variable
                        ),
                    })
                  }
                >
                  <Trash2 className='size-4' aria-hidden />
                </Button>
              </div>
              <div className='space-y-1.5'>
                <label htmlFor={`${key}-value`} className='text-xs font-medium'>
                  {t('Variable value')}
                </label>
                <input
                  id={`${key}-value`}
                  type={variable.secret ? 'password' : 'text'}
                  value={variable.value ?? ''}
                  autoComplete='new-password'
                  spellCheck={false}
                  className={`${inputClass} font-mono`}
                  placeholder={
                    retainedSecret
                      ? t('Saved secret retained; enter a value to replace it')
                      : t('Enter a value')
                  }
                  aria-describedby={
                    retainedSecret ? `${key}-secret-help` : undefined
                  }
                  onChange={(event) =>
                    updateVariable(variable, { value: event.target.value })
                  }
                />
              </div>
              <label className='flex items-center gap-2 text-xs'>
                <input
                  type='checkbox'
                  checked={variable.secret}
                  disabled={props.disabled || retainedSecret}
                  className='accent-foreground focus-visible:ring-ring size-4 rounded focus-visible:ring-2 disabled:opacity-50'
                  aria-label={t('Secret variable {{number}}', {
                    number: index + 1,
                  })}
                  onChange={(event) =>
                    updateVariable(variable, { secret: event.target.checked })
                  }
                />
                {t('Secret')}
              </label>
              {retainedSecret && (
                <p
                  id={`${key}-secret-help`}
                  className='text-muted-foreground text-xs leading-5'
                >
                  {t(
                    'The saved secret is retained. Enter a replacement value before changing its secret setting.'
                  )}
                </p>
              )}
            </fieldset>
          )
        })}
        {props.value.environmentVariables.length >= maxVariables && (
          <p className='text-muted-foreground text-xs'>
            {t('This environment supports up to {{count}} variables.', {
              count: maxVariables,
            })}
          </p>
        )}
      </section>

      <section aria-labelledby={`${id}-privacy`} className='space-y-2'>
        <div className='flex items-center justify-between gap-3'>
          <h3 id={`${id}-privacy`} className='text-sm font-medium'>
            {t('Privacy')}
          </h3>
          <span className='flex items-center gap-1.5 text-xs'>
            <LockKeyhole className='size-3.5' aria-hidden />
            {t('Private')}
          </span>
        </div>
        <p className='text-muted-foreground text-xs leading-5'>
          {t(
            props.capabilities?.unsupportedReasons.sharing ||
              'Only you can use this environment. Shared environments are not available in this runtime.'
          )}
        </p>
      </section>

      <details className='border-t pt-4'>
        <summary className='focus-visible:ring-ring cursor-pointer rounded text-sm font-medium outline-none focus-visible:ring-2'>
          {t('Advanced')}
        </summary>
        <div className='mt-4 space-y-2'>
          <label htmlFor={`${id}-timeout`} className='text-xs font-medium'>
            {t('Setup timeout (seconds)')}
          </label>
          <input
            id={`${id}-timeout`}
            type='text'
            inputMode='numeric'
            value={timeoutDraft.text}
            className={inputClass}
            aria-invalid={timeoutInvalid || undefined}
            aria-describedby={`${id}-timeout-help`}
            onChange={(event) => {
              const text = event.target.value
              const value = text.trim() ? Number(text) : Number.NaN
              setTimeoutDraft({ value, text })
              props.onChange({
                ...props.value,
                advanced: {
                  ...props.value.advanced,
                  setupTimeoutSeconds: value,
                },
              })
            }}
          />
          <p
            id={`${id}-timeout-help`}
            className={
              timeoutInvalid
                ? 'text-destructive text-xs'
                : 'text-muted-foreground text-xs'
            }
          >
            {t('Enter a whole number from 60 to 1800 seconds.')}
          </p>
        </div>
      </details>
    </fieldset>
  )
}
