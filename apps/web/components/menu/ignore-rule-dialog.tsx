"use client"

import * as React from "react"
import { Plus, Trash2 } from "lucide-react"

import { previewIgnoreRule, saveIgnoreRule } from "@/app/(app)/products/actions"
import { Button } from "@/components/ui/button"
import { BrowsePagination } from "@/components/ui/browse-pagination"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { FieldError } from "@/components/ui/field"
import { Input, SearchInput } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TableFrame } from "@/components/ui/table"
import { useToast } from "@/components/ui/toast"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import { toSaveFailure } from "@/lib/save-failure"
import type { Pagination } from "@/lib/backend/pagination"
import {
  SALES_RULE_FIELDS,
  SALES_RULE_OPERATORS,
  type SalesIgnoreRuleCondition,
  type SalesIgnoreRuleMatch,
  type SalesIgnoreRuleRow,
} from "@/lib/backend/types"
import { ruleChannelLabel, salesIdentityKey } from "@/lib/sales-identity"
import { cn } from "@/lib/utils"

const FIELD_LABELS: Record<(typeof SALES_RULE_FIELDS)[number], string> = {
  sku: "SKU",
  title: "Title",
  variant: "Variant",
}

const OPERATOR_LABELS: Record<(typeof SALES_RULE_OPERATORS)[number], string> = {
  is: "is",
  starts_with: "starts with",
  contains: "contains",
}

const STATUS_LABELS: Record<SalesIgnoreRuleMatch["status"], string> = {
  pending: "Will be ignored",
  ignored: "Already ignored",
  tracked: "Tracked — left alone",
}

const MAX_CONDITIONS = 5

/** The first condition's value: what an empty rule is sent back to. */
const CONDITION_FIELD = "ignore-rule-condition"

const emptyCondition = (): SalesIgnoreRuleCondition => ({
  field: "sku",
  operator: "is",
  value: "",
})

const PREVIEW_GRID = "grid-cols-[minmax(0,1fr)_140px_150px] gap-3 min-w-[560px]"
// A rule covering every channel previews both at once, so each row has to say
// which one it came from.
const PREVIEW_GRID_WITH_CHANNEL =
  "grid-cols-[minmax(0,1fr)_140px_110px_150px] gap-3 min-w-[670px]"

const RULE_CHANNELS = ["shopify", "square", null] as const

export function IgnoreRuleDialog({
  rule,
  trigger,
}: {
  rule?: SalesIgnoreRuleRow
  trigger: React.ReactElement
}) {
  const toast = useToast()
  const [open, setOpen] = React.useState(false)
  // `rule ? rule.channel : …` rather than `??`: an existing rule's channel is
  // legitimately null, and a default would silently narrow it to Square.
  const [channel, setChannel] = React.useState<"square" | "shopify" | null>(
    rule ? rule.channel : "square"
  )
  const [conditions, setConditions] = React.useState<
    SalesIgnoreRuleCondition[]
  >(rule?.conditions.length ? rule.conditions : [emptyCondition()])
  // What the dialog opened with: an existing rule is complete from the start,
  // so only a change since then is unsaved work.
  const [entered] = React.useState(() => JSON.stringify([channel, conditions]))

  const [query, setQuery] = React.useState("")
  const [page, setPage] = React.useState(1)
  const [matches, setMatches] = React.useState<SalesIgnoreRuleMatch[]>([])
  const [pagination, setPagination] = React.useState<Pagination | null>(null)
  const [truncated, setTruncated] = React.useState(false)
  const [previewing, startPreview] = React.useTransition()

  // Only complete conditions are worth previewing or saving; a half-typed row
  // would otherwise widen the rule to everything the rest of it matches.
  const complete = React.useMemo(
    () => conditions.filter((row) => row.value.trim().length > 0),
    [conditions]
  )
  const previewGrid =
    channel === null ? PREVIEW_GRID_WITH_CHANNEL : PREVIEW_GRID

  const reset = React.useCallback(() => {
    setChannel(rule ? rule.channel : "square")
    setConditions(
      rule?.conditions.length ? rule.conditions : [emptyCondition()]
    )
    setQuery("")
    setPage(1)
    setMatches([])
    setPagination(null)
    setTruncated(false)
  }, [rule])

  // Debounced so a typed prefix does not fire a request per keystroke.
  const signature = JSON.stringify(complete)
  React.useEffect(() => {
    if (!open || complete.length === 0) return
    const timer = setTimeout(() => {
      startPreview(async () => {
        const result = await previewIgnoreRule({
          channel,
          conditions: complete,
          page,
          q: query.trim() || undefined,
        })
        if ("error" in result) {
          setMatches([])
          setPagination(null)
          return
        }
        setMatches(result.items)
        setPagination(result.meta.pagination)
        setTruncated(result.truncated)
      })
    }, 300)
    return () => clearTimeout(timer)
    // `signature` stands in for `complete`, which is a fresh array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, open, page, query, signature])

  /** Any change to what is being matched invalidates the page we are on. */
  const restartPreview = () => {
    setPage(1)
    setMatches([])
    setPagination(null)
  }

  const update = (index: number, patch: Partial<SalesIgnoreRuleCondition>) => {
    restartPreview()
    setConditions((rows) =>
      rows.map((row, position) =>
        position === index ? { ...row, ...patch } : row
      )
    )
  }

  const form = useFormSave({
    snapshot: JSON.stringify([channel, conditions]),
    // A rule is written whether or not this dialog changed one of its fields.
    saved: false,
    validate: (): FormErrors =>
      complete.length === 0
        ? { [CONDITION_FIELD]: "Enter a value for at least one condition." }
        : {},
    save: async () => {
      const result = await saveIgnoreRule({
        id: rule?.id,
        channel,
        enabled: rule?.enabled ?? true,
        conditions: complete,
      })
      if ("error" in result) return toSaveFailure(result)
      toast.add({
        title: rule ? "Rule updated" : "Rule created",
        description:
          result.ignored === 0
            ? "Nothing matched it yet — it will apply as products arrive."
            : `${result.ignored} ${result.ignored === 1 ? "product" : "products"} ignored.`,
      })
      return null
    },
  })
  const { confirm, dialog } = useDirtyDialog()

  const submit = () =>
    void form.submit().then((done) => {
      if (!done) return
      setOpen(false)
      reset()
    })

  const dismiss = () =>
    confirm(JSON.stringify([channel, conditions]) !== entered, () => {
      setOpen(false)
      reset()
    })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          dismiss()
          return
        }
        setOpen(true)
      }}
    >
      <DialogTrigger render={trigger} />
      {/* One fixed height: a condition, a search or an empty preview moves
          the body, never the dialog. Only the body scrolls. */}
      <DialogContent
        size="lg"
        className="flex h-[min(640px,85dvh)] flex-col"
        onKeyDown={dialogSaveShortcut(submit)}
      >
        <DialogHeader>
          <DialogTitle>{rule ? "Edit rule" : "New rule"}</DialogTitle>
          <DialogDescription>
            Matching products are ignored automatically, so they never reach the
            review queue.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
          <section className="flex shrink-0 flex-col gap-2">
            <h3 className="text-md font-medium text-foreground">Channel</h3>
            <div className="flex flex-wrap gap-2">
              {RULE_CHANNELS.map((value) => (
                <Button
                  key={value ?? "all"}
                  type="button"
                  variant={channel === value ? "default" : "outline"}
                  onClick={() => {
                    restartPreview()
                    setChannel(value)
                  }}
                >
                  {ruleChannelLabel(value)}
                </Button>
              ))}
            </div>
          </section>

          <section className="flex shrink-0 flex-col gap-2">
            <h3 className="text-md font-medium text-foreground">Conditions</h3>
            <p className="text-sm text-muted-foreground">
              Every condition must match. Use Title for a whole product, SKU or
              Variant for one variation. Letter case and spacing are ignored.
            </p>
            {conditions.map((row, index) => (
              <div key={index} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Select
                    value={row.field}
                    onValueChange={(value) =>
                      update(index, {
                        field: value as SalesIgnoreRuleCondition["field"],
                      })
                    }
                  >
                    <SelectTrigger
                      aria-label="Condition field"
                      className="min-w-0 flex-1 md:w-[150px] md:flex-none"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SALES_RULE_FIELDS.map((value) => (
                        <SelectItem key={value} value={value}>
                          {FIELD_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={row.operator}
                    onValueChange={(value) =>
                      update(index, {
                        operator: value as SalesIgnoreRuleCondition["operator"],
                      })
                    }
                  >
                    <SelectTrigger
                      aria-label="Condition operator"
                      className="min-w-0 flex-1 md:w-[160px] md:flex-none"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SALES_RULE_OPERATORS.map((value) => (
                        <SelectItem key={value} value={value}>
                          {OPERATOR_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove condition"
                    disabled={conditions.length === 1}
                    onClick={() => {
                      restartPreview()
                      setConditions((rows) =>
                        rows.filter((_, position) => position !== index)
                      )
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
                <Input
                  id={index === 0 ? CONDITION_FIELD : undefined}
                  value={row.value}
                  maxLength={200}
                  placeholder="Value"
                  aria-label="Condition value"
                  onChange={(event) =>
                    update(index, { value: event.target.value })
                  }
                />
              </div>
            ))}
            {conditions.length < MAX_CONDITIONS ? (
              <Button
                type="button"
                variant="outline"
                className="self-start"
                onClick={() =>
                  setConditions((rows) => [...rows, emptyCondition()])
                }
                // A blank new row cannot change the match set, so the preview
                // stays as it is until the row gets a value.
              >
                <Plus aria-hidden="true" />
                Add condition
              </Button>
            ) : null}
            {form.errors[CONDITION_FIELD] || form.failure ? (
              <FieldError>
                {form.errors[CONDITION_FIELD] ?? form.failure?.message}
              </FieldError>
            ) : null}
          </section>

          {complete.length > 0 ? (
            <section className="flex shrink-0 flex-col gap-2">
              <SearchInput
                label="Search by product title or SKU"
                value={query}
                onChange={(event) => {
                  setPage(1)
                  setQuery(event.target.value)
                }}
              />
              <TableFrame>
                <div className="overflow-x-auto">
                  <div
                    className={cn(
                      "grid h-11 items-center border-b border-border px-3.5 text-2xs font-medium text-ink-soft",
                      previewGrid
                    )}
                  >
                    <span>Product</span>
                    <span>SKU</span>
                    {channel === null ? <span>Channel</span> : null}
                    <span>Status</span>
                  </div>
                  {matches.length === 0 ? (
                    <p className="px-3.5 py-6 text-center text-base text-muted-foreground">
                      {previewing
                        ? "Checking…"
                        : "Nothing matches these conditions yet."}
                    </p>
                  ) : (
                    matches.map((row) => (
                      <div
                        key={salesIdentityKey(row)}
                        className={cn(
                          "grid h-[52px] items-center border-b border-muted px-3.5 last:border-b-0",
                          previewGrid
                        )}
                      >
                        <span
                          className="truncate text-md text-foreground"
                          title={row.externalVariantTitle || undefined}
                        >
                          {row.itemName || "Unnamed item"}
                        </span>
                        <span className="truncate text-base text-muted-foreground tabular-nums">
                          {row.sku || "—"}
                        </span>
                        {channel === null ? (
                          <span className="truncate text-sm text-muted-foreground">
                            {ruleChannelLabel(row.channel)}
                          </span>
                        ) : null}
                        <span
                          className={cn(
                            "text-sm",
                            row.status === "tracked"
                              ? "text-foreground"
                              : "text-muted-foreground"
                          )}
                        >
                          {STATUS_LABELS[row.status]}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </TableFrame>
              {pagination ? (
                <BrowsePagination
                  pagination={pagination}
                  pending={previewing}
                  onPageChange={setPage}
                />
              ) : null}
              {truncated ? (
                <p className="text-xs text-faint">
                  Showing the first matches only — narrow the rule to see them
                  all.
                </p>
              ) : null}
            </section>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={dismiss}>
            Cancel
          </Button>
          <Button type="button" pending={form.pending} onClick={submit}>
            Save rule
          </Button>
        </DialogFooter>
        {dialog}
      </DialogContent>
    </Dialog>
  )
}
