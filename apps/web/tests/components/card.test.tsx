// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

afterEach(cleanup)

describe("Card", () => {
  it("renders its parts inside a card surface", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Butter croissant</CardTitle>
          <CardDescription>Updated this morning</CardDescription>
        </CardHeader>
        <CardContent>Twelve components</CardContent>
      </Card>
    )

    expect(screen.getByText("Butter croissant")).toBeDefined()
    expect(screen.getByText("Updated this morning")).toBeDefined()
    expect(screen.getByText("Twelve components")).toBeDefined()
  })

  it("becomes a link through the render prop", () => {
    render(
      <Card render={<a href="#recipe" />}>
        <CardTitle>Open the recipe</CardTitle>
      </Card>
    )

    const link = screen.getByRole("link", { name: "Open the recipe" })
    expect(link.tagName).toBe("A")
    expect(link.getAttribute("href")).toBe("#recipe")
    expect(link.getAttribute("data-slot")).toBe("card")
  })
})
