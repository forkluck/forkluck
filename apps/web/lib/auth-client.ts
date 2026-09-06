type AuthResult = {
  data?: { user: { id: string; name: string; email: string } }
  /** Set when the account exists but the email still needs its code. */
  pendingVerification?: boolean
  error?: { message: string }
}

function csrfCookie() {
  const prefix = "forkluck_csrf="
  const item = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
  return item ? decodeURIComponent(item.slice(prefix.length)) : ""
}

async function authRequest(
  path: string,
  body: Record<string, string> = {}
): Promise<AuthResult> {
  let response: Response
  let payload: {
    user?: { id: string; name: string; email: string }
    pendingVerification?: boolean
    needsVerification?: boolean
    error?: string
  } | null
  try {
    const signal = AbortSignal.timeout(30_000)
    const csrf = await fetch("/api/auth/csrf", {
      credentials: "same-origin",
      signal,
    })
    if (!csrf.ok) {
      return {
        error: {
          message: "Forkluck is temporarily unavailable. Please try again.",
        },
      }
    }
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      signal,
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": csrfCookie(),
      },
      body: JSON.stringify(body),
    })
    payload = await response.json().catch(() => null)
  } catch (cause) {
    return {
      error: {
        message:
          cause instanceof DOMException && cause.name === "TimeoutError"
            ? "The request timed out. Please try again."
            : "Couldn't connect to Forkluck. Check your connection and try again.",
      },
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      error: {
        message: "Forkluck returned an unreadable response. Please try again.",
      },
    }
  }
  if (payload.pendingVerification || payload.needsVerification) {
    return {
      pendingVerification: true,
      error: payload.error ? { message: payload.error } : undefined,
    }
  }
  if (!response.ok) {
    return { error: { message: payload.error ?? "Request failed" } }
  }
  return payload.user ? { data: { user: payload.user } } : {}
}

export const authClient = {
  signIn: {
    email: (input: { email: string; password: string }) =>
      authRequest("/api/auth/login", input),
  },
  signUp: {
    email: (input: { name: string; email: string; password: string }) =>
      authRequest("/api/auth/register", input),
  },
  verifyEmail: (input: { email: string; code: string }) =>
    authRequest("/api/auth/verify-email", input),
  resendCode: (input: { email: string }) =>
    authRequest("/api/auth/resend-code", input),
  requestPasswordReset: (input: { email: string }) =>
    authRequest("/api/auth/request-password-reset", input),
  resetPassword: (input: { email: string; code: string; password: string }) =>
    authRequest("/api/auth/reset-password", input),
  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    authRequest("/api/auth/change-password", input),
  signOut: () => authRequest("/api/auth/logout"),
}
