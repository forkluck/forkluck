"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ChevronRight } from "lucide-react"

import {
  connectShopifyCredentials,
  connectShopifyToken,
  connectSquareSandboxToken,
} from "@/app/(app)/settings/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FieldError, FieldGroup } from "@/components/ui/field"
import { LabeledInput } from "@/components/ui/labeled-field"
import { TabPill, TabPills } from "@/components/ui/tab-pills"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import { toSaveFailure } from "@/lib/save-failure"

const SQUARE_TOKEN_FIELD = "square-sandbox-token"
const SHOP_FIELD = "shopify-shop"
const CLIENT_ID_FIELD = "shopify-client-id"
const CLIENT_SECRET_FIELD = "shopify-client-secret"
const SHOPIFY_TOKEN_FIELD = "shopify-token"

/** What each credential form hands back to the dialog around it. */
type FormProps = {
  onDone: () => void
  onCancel: () => void
  onDirtyChange: (dirty: boolean) => void
  /** So the dialog around the form can bind Cmd+S to it. */
  submitRef: React.RefObject<(() => void) | null>
}

/** The quiet disclosure under a credential field: how to find the value. */
function SetupNotes({
  summary,
  children,
}: {
  summary: string
  children: React.ReactNode
}) {
  return (
    <details className="group/notes">
      <summary className="flex w-fit list-none items-center gap-1.5 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground">
        <ChevronRight
          className="size-3.5 flex-none text-disabled-foreground group-open/notes:rotate-90"
          strokeWidth={2}
          aria-hidden="true"
        />
        {summary}
      </summary>
      <div className="mt-2 text-xs leading-[1.55] text-muted-foreground">
        {children}
      </div>
    </details>
  )
}

function SquareSandboxForm({
  onDone,
  onCancel,
  onDirtyChange,
  submitRef,
}: FormProps) {
  const router = useRouter()
  const [token, setToken] = React.useState("")

  const form = useFormSave({
    snapshot: token,
    validate: (): FormErrors =>
      token.trim().length >= 10
        ? {}
        : { [SQUARE_TOKEN_FIELD]: "Paste your sandbox access token." },
    save: async () => {
      const result = await connectSquareSandboxToken({
        accessToken: token.trim(),
      })
      return "error" in result ? toSaveFailure(result) : null
    },
  })
  React.useEffect(() => onDirtyChange(form.dirty), [form.dirty, onDirtyChange])

  const submit = () =>
    void form.submit().then((done) => {
      if (!done) return
      onDone()
      router.replace("/integrations/sales/connections?connected=square")
    })
  React.useEffect(() => {
    submitRef.current = submit
  })

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <FieldGroup className="gap-4">
        <LabeledInput
          label="Sandbox access token (EAAA…)"
          id={SQUARE_TOKEN_FIELD}
          type="password"
          value={token}
          autoComplete="off"
          onChange={(event) => setToken(event.target.value)}
        />
        <SetupNotes summary="Where to find it">
          <ol className="list-decimal space-y-1 pl-4">
            <li>
              In the Square Developer Console, open your app’s OAuth section,
              then Test account authorizations.
            </li>
            <li>
              Choose the authorized sandbox test account and copy its access
              token.
            </li>
            <li>Paste it here. Forkluck checks the token before saving it.</li>
          </ol>
        </SetupNotes>
        {form.errors[SQUARE_TOKEN_FIELD] || form.failure ? (
          <FieldError>
            {form.errors[SQUARE_TOKEN_FIELD] ?? form.failure?.message}
          </FieldError>
        ) : null}
      </FieldGroup>
      <DialogFooter className="mt-[18px]">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" pending={form.pending}>
          Connect
        </Button>
      </DialogFooter>
    </form>
  )
}

function ShopifyForm({
  onDone,
  onCancel,
  onDirtyChange,
  submitRef,
}: FormProps) {
  const router = useRouter()
  // Since Jan 2026 new custom apps only exist in the Dev Dashboard, which
  // exposes client credentials instead of a copyable token — so that's the
  // default mode. Legacy pre-2026 admin apps still paste their shpat_ token.
  const [mode, setMode] = React.useState<"credentials" | "token">("credentials")
  const [shop, setShop] = React.useState("")
  const [clientId, setClientId] = React.useState("")
  const [clientSecret, setClientSecret] = React.useState("")
  const [token, setToken] = React.useState("")
  const trimmed = shop
    .trim()
    .toLowerCase()
    .replace(/\.myshopify\.com$/, "")
  const shopValid = /^[a-z0-9][a-z0-9-]*$/.test(trimmed)

  const form = useFormSave({
    snapshot: JSON.stringify([mode, shop, clientId, clientSecret, token]),
    validate: (): FormErrors => ({
      ...(shopValid ? {} : { [SHOP_FIELD]: "Enter your shop domain." }),
      ...(mode === "credentials"
        ? {
            ...(clientId.trim().length >= 10
              ? {}
              : { [CLIENT_ID_FIELD]: "Enter your client ID." }),
            ...(clientSecret.trim().length >= 10
              ? {}
              : { [CLIENT_SECRET_FIELD]: "Enter your client secret." }),
          }
        : token.trim().length >= 10
          ? {}
          : { [SHOPIFY_TOKEN_FIELD]: "Enter your access token." }),
    }),
    save: async () => {
      const shopDomain = `${trimmed}.myshopify.com`
      const result =
        mode === "credentials"
          ? await connectShopifyCredentials({
              shopDomain,
              clientId: clientId.trim(),
              clientSecret: clientSecret.trim(),
            })
          : await connectShopifyToken({ shopDomain, accessToken: token.trim() })
      return "error" in result ? toSaveFailure(result) : null
    },
  })
  React.useEffect(() => onDirtyChange(form.dirty), [form.dirty, onDirtyChange])

  const submit = () =>
    void form.submit().then((done) => {
      if (!done) return
      onDone()
      router.replace("/integrations/sales/connections?connected=shopify")
    })
  React.useEffect(() => {
    submitRef.current = submit
  })

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <FieldGroup className="gap-4">
        <TabPills className="w-fit">
          <TabPill
            active={mode === "credentials"}
            onClick={() => setMode("credentials")}
          >
            Dev Dashboard app
          </TabPill>
          <TabPill active={mode === "token"} onClick={() => setMode("token")}>
            Legacy app token
          </TabPill>
        </TabPills>

        <LabeledInput
          label="Store domain (.myshopify.com)"
          id={SHOP_FIELD}
          value={shop}
          aria-invalid={(shop !== "" && !shopValid) || undefined}
          onChange={(event) => setShop(event.target.value)}
        />
        {form.errors[SHOP_FIELD] ? (
          <FieldError>{form.errors[SHOP_FIELD]}</FieldError>
        ) : null}

        {mode === "credentials" ? (
          <>
            <LabeledInput
              label="Client ID"
              id={CLIENT_ID_FIELD}
              value={clientId}
              autoComplete="off"
              onChange={(event) => setClientId(event.target.value)}
            />
            {form.errors[CLIENT_ID_FIELD] ? (
              <FieldError>{form.errors[CLIENT_ID_FIELD]}</FieldError>
            ) : null}
            <LabeledInput
              label="Client secret"
              id={CLIENT_SECRET_FIELD}
              type="password"
              value={clientSecret}
              autoComplete="off"
              onChange={(event) => setClientSecret(event.target.value)}
            />
            {form.errors[CLIENT_SECRET_FIELD] ? (
              <FieldError>{form.errors[CLIENT_SECRET_FIELD]}</FieldError>
            ) : null}
          </>
        ) : (
          <>
            <LabeledInput
              label="Admin API access token (shpat_…)"
              id={SHOPIFY_TOKEN_FIELD}
              type="password"
              value={token}
              autoComplete="off"
              onChange={(event) => setToken(event.target.value)}
            />
            {form.errors[SHOPIFY_TOKEN_FIELD] ? (
              <FieldError>{form.errors[SHOPIFY_TOKEN_FIELD]}</FieldError>
            ) : null}
          </>
        )}

        <SetupNotes summary="Setup instructions">
          {mode === "credentials" ? (
            <ol className="list-decimal space-y-1 pl-4">
              <li>
                Go to dev.shopify.com, signed in with your store account, then
                Create app and start from the Dev Dashboard. Name it Forkluck.
              </li>
              <li>
                Under API access, Scopes (the first box, not Optional scopes),
                type read_orders,read_all_orders. Both are needed for full
                history; read_all_orders alone does nothing. If Shopify refuses
                to release or install with read_all_orders, remove it and
                continue with read_orders for the last 60 days.
              </li>
              <li>
                Leave Optional scopes and Redirect URLs empty and “Use legacy
                install flow” unchecked, then save and release the version.
              </li>
              <li>On the Home tab, install the app on your store.</li>
              <li>
                In the app’s Settings, copy the Client ID and Client secret and
                paste them here.
              </li>
            </ol>
          ) : (
            <p>
              For custom apps created in your Shopify admin before 2026
              (Settings, Apps and sales channels, Develop apps): open the app’s
              API credentials and paste its Admin API access token (shpat_…).
              New apps cannot be created this way anymore, so use the Dev
              Dashboard option instead.
            </p>
          )}
        </SetupNotes>
        {form.failure ? <FieldError>{form.failure.message}</FieldError> : null}
      </FieldGroup>
      <DialogFooter className="mt-[18px]">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" pending={form.pending}>
          Connect
        </Button>
      </DialogFooter>
    </form>
  )
}

/**
 * The 470px standard modal behind a channel's Connect button. Square in
 * production goes through OAuth instead, so only the credential channels land
 * here: Square's sandbox token in development, Shopify's app credentials.
 */
export function ChannelSetupDialog({
  provider,
  reconnect,
  open,
  onOpenChange,
}: {
  provider: "square" | "shopify"
  /** The stored credentials stopped working, so the copy says so. */
  reconnect: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const name = provider === "square" ? "Square" : "Shopify"
  const close = () => onOpenChange(false)
  const [dirty, setDirty] = React.useState(false)
  const submitRef = React.useRef<(() => void) | null>(null)
  const { confirm, dialog } = useDirtyDialog()

  const dismiss = () => confirm(dirty, close)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss()
      }}
    >
      <DialogContent
        onKeyDown={(event) =>
          dialogSaveShortcut(() => submitRef.current?.())(event)
        }
      >
        <DialogHeader>
          <DialogTitle>
            {reconnect ? `Reconnect ${name}` : `Connect ${name}`}
          </DialogTitle>
          {reconnect ? (
            <DialogDescription>
              {name} stopped accepting the stored credentials. Enter them again
              to resume syncing.
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {provider === "square" ? (
          <SquareSandboxForm
            onDone={close}
            onCancel={dismiss}
            onDirtyChange={setDirty}
            submitRef={submitRef}
          />
        ) : (
          <ShopifyForm
            onDone={close}
            onCancel={dismiss}
            onDirtyChange={setDirty}
            submitRef={submitRef}
          />
        )}
        {dialog}
      </DialogContent>
    </Dialog>
  )
}
