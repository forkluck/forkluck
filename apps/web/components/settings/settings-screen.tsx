"use client"

import * as React from "react"
import Link from "next/link"
import {
  BookOpen,
  ChevronRight,
  CircleArrowUp,
  CreditCard,
  History,
  KeyRound,
  Link2Off,
  Mail,
  Sparkles,
  Tags,
  Trash2,
  User,
  Users,
  Wallet,
} from "lucide-react"

import { AiKeyDialog } from "@/components/invoices/ai-key-dialog"
import { AccountDetailsDialog } from "@/components/settings/account-details-dialog"
import { ChangePasswordDialog } from "@/components/settings/change-password-dialog"
import { BusinessDefaultsDialog } from "@/components/settings/business-defaults-dialog"
import { CategoriesDialog } from "@/components/settings/categories-dialog"
import { HistoryDialog } from "@/components/settings/history-dialog"
import { MembersDialog } from "@/components/settings/members-dialog"
import { PaymentMethodsDialog } from "@/components/settings/payment-methods-dialog"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Page, PageHeader, PageTitle } from "@/components/ui/page"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/components/ui/toast"
import {
  type BillingPortalChoice,
  createBillingPortal,
  deleteKitchenData,
  resetGuestLinks,
  setNewsletter,
} from "@/app/(app)/settings/actions"
import type { SessionUser } from "@/lib/auth-session"
import type { AiKeyStatus, NewsletterStatus } from "@/lib/backend/types"
import { billingStatusLabel, type BillingState } from "@/lib/billing"
import type { BusinessSettings } from "@/lib/business-settings"
import { useGuardedNavigate } from "@/components/navigation-blocker"

/**
 * Settings is a 640px column of grouped cards. Each group is a heading over a
 * bordered card of rows, and a row is the whole hit area: a 17px grey glyph, a
 * 14.5px title over a 13.5px note, and a chevron at the card's edge. Nothing
 * here is a form — every row opens the modal (or the screen) that owns it.
 */
const rowClassName =
  "flex w-full items-center gap-3 border-b border-muted px-4 py-3.5 text-left outline-none last:border-b-0 hover:bg-fill-soft focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-foreground"

function SettingsGroup({
  title,
  note,
  children,
}: {
  title: string
  /** A line under the heading, where the group needs a warning. */
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-[26px] first:mt-0">
      <h2 className="text-md font-semibold text-foreground">{title}</h2>
      {note ? (
        <p className="mt-1 text-base text-muted-foreground">{note}</p>
      ) : null}
      <div className="mt-2.5 overflow-hidden rounded-xl border border-border">
        {children}
      </div>
    </section>
  )
}

function RowBody({
  icon: Icon,
  title,
  note,
  trailing,
}: {
  icon: typeof User
  title: string
  note: string
  /** What sits where the chevron would, for a row that acts in place. */
  trailing?: React.ReactNode
}) {
  return (
    <>
      <span className="flex w-[17px] flex-none items-center justify-center text-muted-foreground">
        <Icon className="size-[17px]" strokeWidth={1.8} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-md text-foreground">{title}</span>
        <span className="mt-[3px] block text-base text-muted-foreground">
          {note}
        </span>
      </span>
      {trailing ?? (
        <ChevronRight
          className="size-[15px] flex-none text-disabled-foreground"
          strokeWidth={2}
          aria-hidden="true"
        />
      )}
    </>
  )
}

/**
 * A modal that starts fresh every time. The dialog stays mounted while closed
 * so focus can return to the row that opened it; `nonce` is its React key, so
 * opening it again builds a new form rather than reviving the cancelled one.
 */
function useRowDialog() {
  const [open, onOpenChange] = React.useState(false)
  const [nonce, setNonce] = React.useState(0)
  const show = React.useCallback(() => {
    setNonce((value) => value + 1)
    onOpenChange(true)
  }, [])
  return { open, nonce, show, onOpenChange }
}

export function SettingsScreen({
  user,
  billing,
  businessSettings,
  byok,
  aiKey,
  newsletter,
}: {
  user: SessionUser
  billing: BillingState
  businessSettings: BusinessSettings
  /** The deployment reads documents with the workspace's own Anthropic key
   * rather than Forkluck's AI, so the key is worth configuring here. */
  byok: boolean
  aiKey: AiKeyStatus
  newsletter: NewsletterStatus
}) {
  const account = useRowDialog()
  const password = useRowDialog()
  const defaults = useRowDialog()
  const members = useRowDialog()
  const categories = useRowDialog()
  const payments = useRowDialog()
  const history = useRowDialog()
  const { go } = useGuardedNavigate()
  const toast = useToast()
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deletePending, startDelete] = React.useTransition()
  const [deleteError, setDeleteError] = React.useState<string | null>(null)
  const [linksOpen, setLinksOpen] = React.useState(false)
  const [linksPending, startLinks] = React.useTransition()
  const [linksError, setLinksError] = React.useState<string | null>(null)
  const [portalPending, startPortal] = React.useTransition()
  const [portalError, setPortalError] = React.useState<string | null>(null)
  const [portalOpen, setPortalOpen] = React.useState(false)
  const [portalChoices, setPortalChoices] = React.useState<
    BillingPortalChoice[]
  >([])
  // Ghost is the record; null (it couldn't say) reads as off.
  const [subscribed, setSubscribed] = React.useState(
    newsletter.enabled === true
  )
  const [newsletterPending, startNewsletter] = React.useTransition()
  const [newsletterError, setNewsletterError] = React.useState<string | null>(
    null
  )

  function onNewsletterChange(next: boolean) {
    const previous = subscribed
    setNewsletterError(null)
    setSubscribed(next)
    startNewsletter(async () => {
      const result = await setNewsletter(next)
      if ("error" in result) {
        setSubscribed(previous)
        setNewsletterError(result.error)
      }
    })
  }

  function openBillingPortal(customerId?: string) {
    setPortalError(null)
    startPortal(async () => {
      const result = await createBillingPortal(customerId)
      if ("error" in result) {
        setPortalError(result.error)
      } else if ("customers" in result) {
        setPortalChoices(result.customers)
        setPortalOpen(true)
      } else {
        window.location.assign(result.url)
      }
    })
  }

  function onDeleteKitchenData() {
    setDeleteError(null)
    startDelete(async () => {
      const result = await deleteKitchenData()
      // The confirm closes either way: the failure line lives on the page,
      // behind the modal that raised it.
      setDeleteOpen(false)
      if ("error" in result) {
        setDeleteError(result.error)
        return
      }
      toast.add({ title: "Kitchen data deleted." })
      void go("/recipes", { force: true })
    })
  }

  function onResetGuestLinks() {
    setLinksError(null)
    startLinks(async () => {
      const result = await resetGuestLinks()
      setLinksOpen(false)
      if ("error" in result) {
        setLinksError(result.error)
        return
      }
      toast.add({ title: "Shared links reset." })
    })
  }

  return (
    <Page>
      <PageHeader>
        <PageTitle>Settings</PageTitle>
      </PageHeader>

      <div className="max-w-[760px]">
        <SettingsGroup title="Account">
          <button type="button" className={rowClassName} onClick={account.show}>
            <RowBody
              icon={User}
              title="Account details"
              note="The name and email this workspace belongs to."
            />
          </button>
          <button
            type="button"
            className={rowClassName}
            onClick={password.show}
          >
            <RowBody
              icon={KeyRound}
              title="Password"
              note={
                user.hasPassword
                  ? "Change the password you use to sign in."
                  : "Set a password so you can also sign in without Google."
              }
            />
          </button>
          <button
            type="button"
            className={rowClassName}
            onClick={defaults.show}
          >
            <RowBody
              icon={BookOpen}
              title="Business defaults"
              note="Units, currency, label region, labor rate, and your food cost target."
            />
          </button>
          {newsletter.available ? (
            <div className="flex w-full items-center gap-3 border-t border-muted px-4 py-3.5">
              <RowBody
                icon={Mail}
                title="Product updates"
                note="Occasional emails about new features and changes."
                trailing={
                  <Switch
                    checked={subscribed}
                    disabled={newsletterPending}
                    onCheckedChange={onNewsletterChange}
                    aria-label="Product updates"
                  />
                }
              />
            </div>
          ) : null}
        </SettingsGroup>
        {newsletterError ? (
          <p role="alert" className="mt-2 text-base text-destructive">
            {newsletterError}
          </p>
        ) : null}

        <SettingsGroup title="Kitchen">
          <button type="button" className={rowClassName} onClick={members.show}>
            <RowBody
              icon={Users}
              title="Members"
              note="Who else can read or edit your recipe book."
            />
          </button>
        </SettingsGroup>

        {billing.status === "disabled" ? null : (
          <>
            <SettingsGroup title="Billing">
              {billing.status === "none" ? null : (
                <button
                  type="button"
                  className={rowClassName}
                  disabled={portalPending}
                  onClick={() => openBillingPortal()}
                >
                  <RowBody
                    icon={CreditCard}
                    title="Manage billing"
                    note={`${billingStatusLabel(billing)}. Your card, invoices, and cancellation live in the Stripe portal.`}
                  />
                </button>
              )}
              {billing.plan === "paid" ? null : (
                <Link href="/subscribe" className={rowClassName}>
                  <RowBody
                    icon={CircleArrowUp}
                    title="Subscribe"
                    note={`${billingStatusLabel(billing)}. $7 a month. Cancel any time.`}
                  />
                </Link>
              )}
            </SettingsGroup>
            {portalError ? (
              <p role="alert" className="mt-2 text-base text-destructive">
                {portalError}
              </p>
            ) : null}
          </>
        )}

        <SettingsGroup title="Data">
          <button
            type="button"
            className={rowClassName}
            onClick={categories.show}
          >
            <RowBody
              icon={Tags}
              title="Categories"
              note="Recipe, ingredient and expense categories."
            />
          </button>
          <button
            type="button"
            className={rowClassName}
            onClick={payments.show}
          >
            <RowBody
              icon={Wallet}
              title="Payment methods"
              note="How invoices get paid."
            />
          </button>
        </SettingsGroup>

        {/* Only a deployment that reads with the workspace's own key has a
            setting here; the house engine needs nothing from the merchant, and
            a row that says so is noise. */}
        {byok ? (
          <SettingsGroup title="Document tools">
            <div className="flex w-full items-center gap-3 px-4 py-3.5">
              <RowBody
                icon={Sparkles}
                title="Claude"
                note="Reads uploaded invoices and receipt photos into lines and prices."
                trailing={
                  <AiKeyDialog
                    configured={aiKey.configured}
                    hint={aiKey.hint}
                    label="Configure"
                  />
                }
              />
            </div>
          </SettingsGroup>
        ) : null}

        <SettingsGroup title="History">
          <button type="button" className={rowClassName} onClick={history.show}>
            <RowBody
              icon={History}
              title="History"
              note="What changed in this workspace and when."
            />
          </button>
        </SettingsGroup>

        <SettingsGroup
          title="Danger zone"
          note="Destructive actions that affect your whole workspace."
        >
          <div className="flex w-full items-center gap-3 px-4 py-3.5">
            <RowBody
              icon={Trash2}
              title="Delete all kitchen data"
              note="Permanently delete all kitchen and sales data from the database."
              trailing={
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleteOpen(true)}
                >
                  Delete
                </Button>
              }
            />
          </div>
          <div className="flex w-full items-center gap-3 border-t border-muted px-4 py-3.5">
            <RowBody
              icon={Link2Off}
              title="Reset all shared links"
              note="Invalidate every active guest link across your site. Anyone holding one will lose access."
              trailing={
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setLinksOpen(true)}
                >
                  Reset
                </Button>
              }
            />
          </div>
        </SettingsGroup>
        {deleteError ? (
          <p role="alert" className="mt-2 text-base text-destructive">
            {deleteError}
          </p>
        ) : null}
        {linksError ? (
          <p role="alert" className="mt-2 text-base text-destructive">
            {linksError}
          </p>
        ) : null}
      </div>

      <AccountDetailsDialog
        key={`account-${account.nonce}`}
        user={user}
        open={account.open}
        onOpenChange={account.onOpenChange}
      />
      <ChangePasswordDialog
        key={`password-${password.nonce}`}
        hasPassword={user.hasPassword}
        open={password.open}
        onOpenChange={password.onOpenChange}
      />
      <BusinessDefaultsDialog
        key={`defaults-${defaults.nonce}`}
        initialSettings={businessSettings}
        open={defaults.open}
        onOpenChange={defaults.onOpenChange}
      />
      <CategoriesDialog
        key={`categories-${categories.nonce}`}
        open={categories.open}
        onOpenChange={categories.onOpenChange}
      />
      <MembersDialog
        key={`members-${members.nonce}`}
        open={members.open}
        onOpenChange={members.onOpenChange}
      />
      <PaymentMethodsDialog
        key={`payments-${payments.nonce}`}
        open={payments.open}
        onOpenChange={payments.onOpenChange}
      />
      <HistoryDialog
        key={`history-${history.nonce}`}
        open={history.open}
        onOpenChange={history.onOpenChange}
      />
      <Dialog open={portalOpen} onOpenChange={setPortalOpen}>
        <DialogContent>
          <DialogTitle>Choose a billing account</DialogTitle>
          <DialogDescription>
            Your subscriptions use more than one Stripe billing account. Choose
            which one you want to manage.
          </DialogDescription>
          <div className="flex flex-col gap-2">
            {portalChoices.map((choice) => (
              <Button
                key={choice.id}
                variant="outline"
                pending={portalPending}
                className="justify-start"
                onClick={() => openBillingPortal(choice.id)}
              >
                <CreditCard className="size-[17px]" aria-hidden="true" />
                {choice.label}
              </Button>
            ))}
          </div>
          {portalError ? (
            <p role="alert" className="text-base text-destructive">
              {portalError}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete all kitchen data?"
        description="This is permanent. There is no undo."
        confirmText="DELETE"
        confirmLabel="Delete"
        pending={deletePending}
        onConfirm={onDeleteKitchenData}
      />
      <ConfirmDialog
        open={linksOpen}
        onOpenChange={setLinksOpen}
        title="Reset all shared links?"
        description="Every guest link stops working. Anyone holding one loses access."
        confirmLabel="Reset"
        pending={linksPending}
        onConfirm={onResetGuestLinks}
      />
    </Page>
  )
}
