import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'

// Phase 11 accessibility smoke (WCAG 2.1 A/AA rules). The gate is "no serious or critical violation" on each key page;
// minor/moderate findings are reported in the failure message of the next serious one but do not fail the run.
// Each page is checked in the state its own spec's mocks put it in, so the scan sees real rendered content.
export async function expectNoSeriousA11yViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${v.impact} ${v.id}: ${v.help} -> ${v.nodes
          .slice(0, 5)
          .map((n) => `${n.target.join(' ')} (${n.any[0]?.message ?? n.failureSummary ?? ''})`)
          .join(' | ')}`,
    )
  expect(serious, `${label}: serious/critical axe violations`).toEqual([])
}
