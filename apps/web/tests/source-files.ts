import { readdirSync } from "node:fs"
import { join } from "node:path"

/** Every TypeScript source under a directory, for the pins that read code. */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    )
    .map((entry) => join(entry.parentPath, entry.name))
}
