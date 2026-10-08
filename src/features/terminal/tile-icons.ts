import {
  Beer,
  Bike,
  CakeSlice,
  ChefHat,
  ClipboardList,
  Coffee,
  ConciergeBell,
  Cookie,
  Croissant,
  GlassWater,
  IceCreamCone,
  Pizza,
  Salad,
  Sandwich,
  ShieldCheck,
  Soup,
  Star,
  Truck,
  UserRound,
  Utensils,
  Wallet,
  Wine,
  type LucideIcon,
} from 'lucide-react'

/**
 * Allowlist of icon slugs a role row may name (roles.icon is a free `[a-z0-9-]` slug in the DB). It is keyed by ICON
 * slug, i.e. by presentation data, never by a role or station name. Anything else falls back to a generic person icon,
 * so an unknown slug can never break a tile or load arbitrary code.
 */
const TILE_ICONS: Readonly<Record<string, LucideIcon>> = {
  'concierge-bell': ConciergeBell,
  'chef-hat': ChefHat,
  croissant: Croissant,
  coffee: Coffee,
  wallet: Wallet,
  'shield-check': ShieldCheck,
  utensils: Utensils,
  'cake-slice': CakeSlice,
  'glass-water': GlassWater,
  wine: Wine,
  beer: Beer,
  pizza: Pizza,
  soup: Soup,
  sandwich: Sandwich,
  'ice-cream-cone': IceCreamCone,
  cookie: Cookie,
  salad: Salad,
  'clipboard-list': ClipboardList,
  truck: Truck,
  bike: Bike,
  star: Star,
  user: UserRound,
}

export const GENERIC_TILE_ICON: LucideIcon = UserRound

/** Icon for a row's icon slug (role, station, ...) from the same allowlist; unknown or missing slugs get `fallback`. */
export function iconForSlug(slug: string | null | undefined, fallback: LucideIcon): LucideIcon {
  if (!slug || !Object.prototype.hasOwnProperty.call(TILE_ICONS, slug)) return fallback
  return TILE_ICONS[slug] ?? fallback
}

export function tileIconFor(slug: string | null | undefined): LucideIcon {
  return iconForSlug(slug, GENERIC_TILE_ICON)
}
