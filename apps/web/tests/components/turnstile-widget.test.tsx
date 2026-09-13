// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render } from "@testing-library/react"

import { TurnstileWidget } from "@/components/auth/turnstile-widget"

type Options = Parameters<TurnstileApi["render"]>[1]

function stubTurnstile() {
  const api = {
    render: vi.fn<(node: HTMLElement, options: Options) => string>(
      () => "widget-1"
    ),
    reset: vi.fn(),
    remove: vi.fn(),
    getResponse: vi.fn(),
  }
  window.turnstile = api
  return api
}

afterEach(() => {
  cleanup()
  delete window.turnstile
  document.head.querySelectorAll("script").forEach((node) => node.remove())
})

describe("TurnstileWidget", () => {
  it("renders the widget once, relays its tokens, and removes it on unmount", async () => {
    const api = stubTurnstile()
    const onToken = vi.fn()
    const view = render(
      <TurnstileWidget siteKey="site-key" onToken={onToken} resetSignal={0} />
    )
    await vi.waitFor(() => expect(api.render).toHaveBeenCalledTimes(1))
    const [node, options] = api.render.mock.calls[0]
    expect(node).toBe(view.container.firstChild)
    expect(options.sitekey).toBe("site-key")
    expect(options.action).toBe("signup")

    options.callback?.("tok_1")
    expect(onToken).toHaveBeenLastCalledWith("tok_1")
    options["expired-callback"]?.()
    expect(onToken).toHaveBeenLastCalledWith(null)
    options["error-callback"]?.()
    expect(onToken).toHaveBeenLastCalledWith(null)

    view.rerender(
      <TurnstileWidget siteKey="site-key" onToken={onToken} resetSignal={1} />
    )
    expect(api.reset).toHaveBeenCalledWith("widget-1")
    expect(api.render).toHaveBeenCalledTimes(1)

    view.unmount()
    expect(api.remove).toHaveBeenCalledWith("widget-1")
  })

  it("loads Cloudflare's script when it is not on the page yet", () => {
    render(<TurnstileWidget siteKey="site-key" onToken={vi.fn()} />)
    const script = document.head.querySelector("script")
    expect(script?.getAttribute("src")).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
    )
    expect(script?.async).toBe(true)
  })
})
