import { useParams } from 'react-router-dom'

/** Tenant-aware route skeleton for `/r/:slug/*`. Resolver + auth land in Phase 1. */
export default function TenantRoutes() {
  const { slug } = useParams<{ slug: string }>()
  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-xl font-semibold text-ink">Restaurant</h1>
      <p className="text-muted-foreground" data-testid="tenant-slug">
        {slug}
      </p>
    </main>
  )
}
