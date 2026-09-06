/** Why a save did not land, whatever shape the failure arrived in. */
export type SaveFailure = {
  kind: "validation" | "conflict" | "request"
  message: string
  /** What the server says the record is at now, on a conflict. */
  version?: number
}

// What Next throws when the tab's bundle predates the deploy now serving.
// Two spellings: the one the runtime raised before it had an error class of
// its own, and the one UnrecognizedActionError carries now.
const MISSING_SERVER_ACTION =
  /Failed to find (the )?Server Action|Server Action .* was not found on the server/i

/** The deploy-skew failure, rewritten as something a cook can act on. */
const DEPLOYED =
  "A new version was deployed. Reload the page to keep editing — your latest changes are still on this screen."

const DEFAULT = "The change was not saved. Try again."

/** Whether this failure is the tab talking to a deploy it does not know. */
export function isDeploySkew(value: unknown): boolean {
  if (!(value instanceof Error)) return false
  // Named rather than imported: next/navigation's guard would pull the
  // router into a module every save path already depends on.
  return (
    value.name === "UnrecognizedActionError" ||
    MISSING_SERVER_ACTION.test(value.message)
  )
}

export const DEPLOY_SKEW_MESSAGE = DEPLOYED

/** An `{error}` result, a thrown error or anything else, as one failure. */
export function toSaveFailure(value: unknown): SaveFailure {
  if (isDeploySkew(value)) return { kind: "request", message: DEPLOYED }
  if (value instanceof Error) return request(value.message)
  if (typeof value === "object" && value !== null && "error" in value) {
    const record = value as {
      error: unknown
      code?: unknown
      editVersion?: unknown
    }
    const message = typeof record.error === "string" ? record.error : ""
    if (record.code === "stale_write")
      return {
        kind: "conflict",
        message: message || DEFAULT,
        ...(typeof record.editVersion === "number"
          ? { version: record.editVersion }
          : {}),
      }
    return request(message)
  }
  return request(typeof value === "string" ? value : "")
}

function request(message: string): SaveFailure {
  return {
    kind: "request",
    message: MISSING_SERVER_ACTION.test(message)
      ? DEPLOYED
      : message || DEFAULT,
  }
}
