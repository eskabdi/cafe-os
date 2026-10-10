import { PageHeader } from '@/components/portal/page-header'
import { TrustedDevicesCard } from '@/features/auth'

/** The Super Admin's own security: devices trusted to skip the authenticator code for 30 days. */
export function PlatformSecurityPage() {
  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader title="Security" description="Your trusted devices. Remove one you no longer use or do not recognise." />
      <TrustedDevicesCard />
    </div>
  )
}
