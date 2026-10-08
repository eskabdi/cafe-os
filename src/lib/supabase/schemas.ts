import { z } from 'zod'
import { isUuid } from '@/lib/domain/navigation'

// Shared zod building blocks for Phase-3 responses. Postgres `numeric` arrives as a JSON number (PostgREST and
// jsonb_build_object); a numeric string is accepted too, anything else fails the parse.

export const uuid = z.string().refine(isUuid, 'uuid')

export const numericValue = z
  .union([z.number(), z.string().regex(/^-?\d+(?:\.\d+)?$/).transform(Number)])
  .pipe(z.number().finite())

/** #rrggbb or null (a malformed colour is dropped to null, never applied to a style). */
export const rowColor = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional().catch(null)
/** Icon slug or null (resolved through an allowlist, unknown slugs fall back to a generic icon). */
export const rowIcon = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).nullable().optional().catch(null)
