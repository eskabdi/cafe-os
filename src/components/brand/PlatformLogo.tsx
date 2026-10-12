/** The CafeOS platform mark (static asset, same origin). Tenant pages show the tenant's own logo; this is the platform brand. */
export function PlatformLogo({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <img
      src="/icons/logo-96.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      decoding="async"
      className={`shrink-0 ${className}`}
    />
  )
}
