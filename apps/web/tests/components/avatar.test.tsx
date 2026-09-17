// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

afterEach(cleanup)

describe("Avatar", () => {
  it("shows the initials when there is no image", () => {
    render(
      <Avatar>
        <AvatarFallback>FL</AvatarFallback>
      </Avatar>
    )

    expect(screen.getByText("FL")).toBeDefined()
  })

  it("keeps the initials up while the photo has not loaded", () => {
    render(
      <Avatar size="lg">
        <AvatarImage src="/chef.jpg" alt="Head chef" />
        <AvatarFallback>HC</AvatarFallback>
      </Avatar>
    )

    expect(screen.getByText("HC")).toBeDefined()
    expect(screen.queryByAltText("Head chef")).toBeNull()
  })
})
