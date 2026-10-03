import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-2xl font-semibold text-ink">Page not found</h1>
      <Link to="/" className="text-primary underline-offset-4 hover:underline">
        Back to start
      </Link>
    </main>
  )
}
