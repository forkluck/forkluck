// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { Button } from "@/components/ui/button"
import { MetricComparisonBadge } from "@/components/ui/metric-comparison-badge"
import { NoticeBanner, NoticeBannerAction } from "@/components/ui/notice-banner"
import { EmptyState, Page, PageHeader, PageTitle } from "@/components/ui/page"

afterEach(cleanup)

describe("design-system component layers", () => {
  it("keeps primitive button behavior and disabled semantics together", () => {
    const onClick = vi.fn()
    const { rerender } = render(<Button onClick={onClick}>Add item</Button>)

    fireEvent.click(screen.getByRole("button", { name: "Add item" }))
    expect(onClick).toHaveBeenCalledOnce()

    rerender(
      <Button disabled onClick={onClick}>
        Add item
      </Button>
    )
    const disabledButton = screen.getByRole("button", { name: "Add item" })
    expect(disabledButton.hasAttribute("disabled")).toBe(true)
    fireEvent.click(disabledButton)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it("renders component-level metric meaning without a comparison at zero", () => {
    const { rerender } = render(
      <MetricComparisonBadge
        current={120}
        previous={100}
        label="Net sales against the prior week"
      />
    )

    expect(
      screen.getByLabelText("Net sales against the prior week").textContent
    ).toBe("+20%")

    rerender(<MetricComparisonBadge current={120} previous={0} />)
    expect(screen.queryByText("+20%")).toBeNull()
  })

  it("keeps the notice pattern's message and action accessible", () => {
    render(
      <NoticeBanner action={<NoticeBannerAction>Review</NoticeBannerAction>}>
        Two products need attention
      </NoticeBanner>
    )

    expect(screen.getByText("Two products need attention")).toBeDefined()
    expect(screen.getByRole("button", { name: "Review" })).toBeDefined()
  })

  it("provides page-template landmarks and heading hierarchy", () => {
    render(
      <Page>
        <PageHeader>
          <PageTitle>Ingredients</PageTitle>
        </PageHeader>
        <EmptyState
          title="No ingredients yet"
          description="Add the first ingredient to begin costing recipes."
        >
          <Button>Add ingredient</Button>
        </EmptyState>
      </Page>
    )

    expect(screen.getByRole("main")).toBeDefined()
    expect(
      screen.getByRole("heading", { level: 1, name: "Ingredients" })
    ).toBeDefined()
    expect(
      screen.getByRole("heading", { level: 2, name: "No ingredients yet" })
    ).toBeDefined()
  })
})
