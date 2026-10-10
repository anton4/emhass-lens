// A list's filters and sort in the URL (?d.day=2026-10-10&d.sort=at&d.dir=asc), so a filtered view can be linked
// and survives a reload. `prefix` keeps two lists on one page apart.

import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { dayBounds } from './days'
import type { SortDir, SortState } from './sort'

export interface ListParams {
  day: string // '' = latest
  q: string
  filter: string
  mismatch: boolean
  sort: SortState
}

export type ListPatch = Partial<Omit<ListParams, 'sort'>> & {
  sort?: SortState
}

export function useListParams(prefix: string, defaultSort: SortState): [ListParams, (patch: ListPatch) => void] {
  const [params, setParams] = useSearchParams()
  const p = (key: string) => `${prefix}${key}`
  const value = useMemo<ListParams>(
    () => ({
      day: params.get(p('day')) ?? '',
      q: params.get(p('q')) ?? '',
      filter: params.get(p('f')) ?? '',
      mismatch: params.get(p('mm')) === '1',
      sort: {
        key: params.get(p('sort')) ?? defaultSort.key,
        dir: ((params.get(p('dir')) as SortDir | null) ?? defaultSort.dir) === 'asc' ? 'asc' : 'desc',
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params, prefix, defaultSort.key, defaultSort.dir],
  )
  const update = useCallback(
    (patch: ListPatch) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          const put = (key: string, v: string | boolean | undefined) => {
            if (v === undefined) return
            if (v === '' || v === false) next.delete(p(key))
            else next.set(p(key), v === true ? '1' : v)
          }
          put('day', patch.day)
          put('q', patch.q)
          put('f', patch.filter)
          put('mm', patch.mismatch)
          if (patch.sort) {
            const isDefault = patch.sort.key === defaultSort.key && patch.sort.dir === defaultSort.dir
            put('sort', isDefault ? '' : patch.sort.key)
            put('dir', isDefault ? '' : patch.sort.dir)
          }
          return next
        },
        { replace: true },
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setParams, prefix, defaultSort.key, defaultSort.dir],
  )
  return [value, update]
}

/** Run filters for a list: the latest `latest` runs of `job`, or every run of the chosen day (up to 1000). */
export function runFilters(job: string, day: string, timeZone: string | undefined, latest: number) {
  return day ? { job, ...dayBounds(day, timeZone), limit: 1000 } : { job, limit: latest }
}
