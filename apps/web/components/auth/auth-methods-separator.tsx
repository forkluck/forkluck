export function AuthMethodsSeparator() {
  return (
    <div
      aria-hidden="true"
      className="relative my-5 flex items-center justify-center"
    >
      <div className="absolute inset-x-0 border-t border-border" />
      <span className="relative bg-card px-3 text-xs text-muted-foreground">
        or
      </span>
    </div>
  )
}
