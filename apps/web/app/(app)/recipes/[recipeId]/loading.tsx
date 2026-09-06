import { Spinner } from "@/components/ui/spinner"

/** Shown under the title and tabs while a section loads, so the chrome stays
    put and only the section below the rule waits. */
export default function Loading() {
  return (
    <div className="grid min-h-[40vh] place-items-center" aria-busy="true">
      <Spinner size="lg" delayed label="Loading section" />
    </div>
  )
}
