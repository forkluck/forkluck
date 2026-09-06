"use client"

import * as React from "react"

import {
  DEFAULT_BUSINESS_SETTINGS,
  type BusinessSettings,
} from "@/lib/business-settings"

const BusinessSettingsContext = React.createContext<BusinessSettings>(
  DEFAULT_BUSINESS_SETTINGS
)

export function BusinessSettingsProvider({
  settings,
  children,
}: {
  settings: BusinessSettings
  children: React.ReactNode
}) {
  // The backend read is an unvalidated cast, so a payload predating the label
  // region arrives without one. It has to read as US, the server-side default.
  const value = React.useMemo(
    () => ({
      ...settings,
      labelRegion:
        settings.labelRegion ?? DEFAULT_BUSINESS_SETTINGS.labelRegion,
    }),
    [settings]
  )
  return (
    <BusinessSettingsContext value={value}>{children}</BusinessSettingsContext>
  )
}

export function useBusinessSettings(): BusinessSettings {
  return React.useContext(BusinessSettingsContext)
}
