import { ComingSoonState } from './states'
import type { ModuleNavItem } from './nav-config'

/** Placeholder for a module that is in the navigation catalogue but not built yet. */
export function ComingSoonPage({ module }: { module: Pick<ModuleNavItem, 'label' | 'summary'> }) {
  return (
    <div className="p-4 lg:p-6">
      <ComingSoonState title={module.label} summary={module.summary} />
    </div>
  )
}
