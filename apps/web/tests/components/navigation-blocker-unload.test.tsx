// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import {
  NavigationBlockerProvider,
  useNavigationBlocker,
} from "@/components/navigation-blocker"

function Screen({ saveOnLeave }: { saveOnLeave: boolean }) {
  const { setIsBlocked, beforeLeaveRef } = useNavigationBlocker()
  React.useEffect(() => {
    if (saveOnLeave) beforeLeaveRef.current = () => Promise.resolve(true)
  }, [beforeLeaveRef, saveOnLeave])
  return (
    <button type="button" onClick={() => setIsBlocked(true)}>
      Dirty
    </button>
  )
}

function screenWith(saveOnLeave: boolean) {
  render(
    <NavigationBlockerProvider>
      <Screen saveOnLeave={saveOnLeave} />
    </NavigationBlockerProvider>
  )
}

/** What the browser asks before it closes the tab. */
function unloadPrompts() {
  const event = new Event("beforeunload", { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

afterEach(cleanup)

describe("closing the window on unsaved work", () => {
  it("says nothing while everything is saved", () => {
    screenWith(false)

    expect(unloadPrompts()).toBe(false)
  })

  it("prompts once the screen holds unsaved work", () => {
    screenWith(false)

    fireEvent.click(screen.getByText("Dirty"))

    expect(unloadPrompts()).toBe(true)
  })

  it("prompts even where a screen saves on the way out", () => {
    screenWith(true)

    fireEvent.click(screen.getByText("Dirty"))

    expect(unloadPrompts()).toBe(true)
  })
})
