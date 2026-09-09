export const authNotice = {
  "google-not-configured": {
    role: "alert",
    message: "Google sign-in is unavailable. Use your email and password.",
  },
  "google-cancelled": {
    role: "status",
    message: "Google sign-in was cancelled.",
  },
  "google-state": {
    role: "alert",
    message: "That Google sign-in link expired. Try again.",
  },
  "google-failed": {
    role: "alert",
    message: "Google sign-in didn't complete. Try again or use your password.",
  },
  "google-unverified-email": {
    role: "alert",
    message:
      "Google hasn't verified that email address. Use a verified Google account or your password.",
  },
  "google-inactive": {
    role: "alert",
    message: "This account is inactive. Contact support for help.",
  },
  "google-rate-limited": {
    role: "alert",
    message:
      "Too many Google sign-in attempts. Wait a few minutes and try again.",
  },
} as const

export type AuthNoticeCode = keyof typeof authNotice

export function authNoticeCode(
  value: string | string[] | undefined
): AuthNoticeCode | undefined {
  return typeof value === "string" && Object.hasOwn(authNotice, value)
    ? (value as AuthNoticeCode)
    : undefined
}
