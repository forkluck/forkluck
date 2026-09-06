"use client"

import * as React from "react"

import { deleteIgnoreRule, saveIgnoreRule } from "@/app/(app)/products/actions"
import { IgnoreRuleDialog } from "@/components/menu/ignore-rule-dialog"
import { ProductsToolbar } from "@/components/menu/products-toolbar"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { FilterPill } from "@/components/ui/filter-pill"
import { EmptyState } from "@/components/ui/page"
import { Switch } from "@/components/ui/switch"
import { TableFrame } from "@/components/ui/table"
import { useToast } from "@/components/ui/toast"
import type { SalesIgnoreRuleRow } from "@/lib/backend/types"
import { channelLabel, ruleChannelLabel } from "@/lib/sales-identity"
import { cn } from "@/lib/utils"

const GRID =
  "grid-cols-[minmax(0,1fr)_130px_110px_84px_150px] gap-3 min-w-[740px]"

const FIELD_LABELS = { sku: "SKU", title: "Title", variant: "Variant" } as const
const OPERATOR_LABELS = {
  is: "is",
  starts_with: "starts with",
  contains: "contains",
} as const

/** The conditions are the rule's name, so they have to read as a sentence. */
function describeRule(rule: SalesIgnoreRuleRow): string {
  return rule.conditions
    .map(
      (condition) =>
        `${FIELD_LABELS[condition.field]} ${OPERATOR_LABELS[condition.operator]} “${condition.value}”`
    )
    .join(" and ")
}

export function IgnoreRulesTable({ rules }: { rules: SalesIgnoreRuleRow[] }) {
  const toast = useToast()
  const [query, setQuery] = React.useState("")
  const [channel, setChannel] = React.useState<"all" | "shopify" | "square">(
    "all"
  )
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState<SalesIgnoreRuleRow | null>(
    null
  )

  const rows = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return rules.filter(
      (rule) =>
        // A rule covering every channel belongs under either channel's filter.
        (channel === "all" ||
          rule.channel === null ||
          rule.channel === channel) &&
        (!needle || describeRule(rule).toLocaleLowerCase().includes(needle))
    )
  }, [channel, query, rules])

  const toggleEnabled = async (rule: SalesIgnoreRuleRow, enabled: boolean) => {
    setPendingId(rule.id)
    const result = await saveIgnoreRule({
      id: rule.id,
      channel: rule.channel,
      enabled,
      conditions: rule.conditions,
    })
    setPendingId(null)
    if ("error" in result) {
      toast.add({
        title: "Couldn’t update that rule",
        description: result.error,
        type: "error",
      })
      return
    }
    toast.add({
      title: enabled ? "Rule enabled" : "Rule disabled",
      description: enabled
        ? `${result.ignored} ${result.ignored === 1 ? "product" : "products"} ignored.`
        : "Its products are back in Catalog.",
    })
  }

  const remove = async (rule: SalesIgnoreRuleRow) => {
    setPendingId(rule.id)
    const result = await deleteIgnoreRule(rule.id)
    setPendingId(null)
    setConfirming(null)
    if ("error" in result) {
      toast.add({
        title: "Couldn’t delete that rule",
        description: result.error,
        type: "error",
      })
      return
    }
    toast.add({
      title: "Rule deleted",
      description: `${result.restored} ${result.restored === 1 ? "product is" : "products are"} back in Catalog.`,
    })
  }

  return (
    <>
      <ProductsToolbar
        query={query}
        onQueryChange={setQuery}
        searchLabel="Search rules"
        filter={
          <FilterPill
            label="Channel"
            value={channel}
            options={[
              { value: "all", label: "All" },
              { value: "shopify", label: channelLabel("shopify") },
              { value: "square", label: channelLabel("square") },
            ]}
            onSelect={setChannel}
          />
        }
        action={
          <IgnoreRuleDialog
            trigger={<Button className="shrink-0">New rule</Button>}
          />
        }
      />

      {rules.length === 0 ? (
        <EmptyState
          title="Create auto-ignore rules"
          description="Keep gift cards, fees, or a whole SKU prefix out of the review queue. Matching products are ignored as they arrive, so you never triage them twice."
        >
          <IgnoreRuleDialog trigger={<Button>New rule</Button>} />
        </EmptyState>
      ) : (
        <TableFrame>
          <div className="overflow-x-auto">
            <div
              className={cn(
                "grid h-11 items-center border-b border-border px-3.5 text-2xs font-medium text-ink-soft",
                GRID
              )}
            >
              <span>Rule</span>
              <span>Channel</span>
              <span className="text-right">Ignored</span>
              <span className="text-right">Active</span>
              <span />
            </div>

            {rows.length === 0 ? (
              <p className="px-3.5 py-6 text-center text-base text-muted-foreground">
                No rules match that filter.
              </p>
            ) : (
              rows.map((rule) => (
                <div
                  key={rule.id}
                  className={cn(
                    "grid min-h-[58px] items-center border-b border-muted px-3.5 last:border-b-0 hover:bg-fill-soft",
                    GRID
                  )}
                >
                  <span className="truncate text-md text-foreground">
                    {describeRule(rule)}
                  </span>
                  <span className="truncate text-base text-muted-foreground">
                    {ruleChannelLabel(rule.channel)}
                  </span>
                  <span
                    className="text-right text-base text-muted-foreground tabular-nums"
                    title="Products this rule currently holds"
                  >
                    {rule.ignoredCount}
                  </span>
                  <span className="flex justify-end">
                    <Switch
                      checked={rule.enabled}
                      disabled={pendingId !== null}
                      aria-label={`Enable ${describeRule(rule)}`}
                      onCheckedChange={(checked) =>
                        void toggleEnabled(rule, checked)
                      }
                    />
                  </span>
                  <span className="flex justify-end gap-2">
                    <IgnoreRuleDialog
                      rule={rule}
                      trigger={<Button variant="outline">Edit</Button>}
                    />
                    <Button
                      variant="ghost"
                      disabled={pendingId !== null}
                      onClick={() => setConfirming(rule)}
                    >
                      Delete
                    </Button>
                  </span>
                </div>
              ))
            )}
          </div>
        </TableFrame>
      )}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(next) => {
          if (!next) setConfirming(null)
        }}
        title="Delete this rule?"
        description={
          confirming
            ? `${confirming.ignoredCount} ${confirming.ignoredCount === 1 ? "product returns" : "products return"} to Catalog for a decision. Products you ignored by hand stay ignored.`
            : ""
        }
        confirmLabel="Delete rule"
        pending={pendingId !== null}
        onConfirm={() => {
          if (confirming) void remove(confirming)
        }}
      />
    </>
  )
}
