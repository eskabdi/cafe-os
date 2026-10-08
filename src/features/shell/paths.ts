// Paths are built from the identity's own tenant slug (session context), never from the URL slug.
export const modulePath = (slug: string, segment: string) => `/r/${slug}/${segment}`
export const stationPath = (slug: string, stationId: string) => `/r/${slug}/stations/${stationId}`
