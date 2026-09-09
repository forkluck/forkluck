"use client"

import { useEffect, useState } from "react"

type SignInMethod = "google" | "password"
const key = "fl.last-sign-in-method"

export function readLastSignInMethod(): SignInMethod | null {
  try {
    const value = window.localStorage.getItem(key)
    return value === "google" || value === "password" ? value : null
  } catch {
    return null
  }
}

export function writeLastSignInMethod(method: SignInMethod): void {
  try {
    window.localStorage.setItem(key, method)
  } catch {
    // Sign-in still works when the browser blocks storage.
  }
}

export function useLastSignInMethod(): SignInMethod | null {
  const [method, setMethod] = useState<SignInMethod | null>(null)
  useEffect(() => {
    // The server cannot know this browser's last method; read after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMethod(readLastSignInMethod())
  }, [])
  return method
}
