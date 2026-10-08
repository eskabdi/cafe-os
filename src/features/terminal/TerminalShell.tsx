import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

/** Full-height shell for the shared terminal. Nothing tenant- or person-specific goes in the title or chrome. */
export function TerminalShell({ slug, children }: { slug: string | null; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6">
      <header className="text-center">
        <p className="text-2xl font-bold text-ink">
          Cafe<span className="text-primary">OS</span>
        </p>
      </header>
      <div className="flex-1">{children}</div>
      <footer className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 pb-2 text-sm">
        {slug ? (
          <>
            <Link
              className="inline-flex min-h-[44px] items-center text-ink underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              to={`/r/${slug}/login`}
            >
              Sign in with username
            </Link>
            <Link
              className="inline-flex min-h-[44px] items-center text-ink underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              to={`/r/${slug}/admin-login`}
            >
              Admin sign-in
            </Link>
          </>
        ) : null}
      </footer>
    </main>
  )
}
