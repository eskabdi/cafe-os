export function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-3xl font-bold text-ink">
        Cafe<span className="text-primary">OS</span>
      </h1>
      <p className="text-muted-foreground">
        Restaurant operations platform. Open your restaurant at /r/&lt;slug&gt;.
      </p>
    </main>
  )
}
