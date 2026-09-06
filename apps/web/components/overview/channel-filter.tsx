"use client"

import { FilterPill } from "@/components/ui/filter-pill"

export type Channel = "all" | "shopify" | "square"
export type ConnectedChannel = Exclude<Channel, "all">

const channelOrder: ConnectedChannel[] = ["shopify", "square"]

function channelLabel(channel: ConnectedChannel) {
  return channel === "square" ? "Square" : "Shopify"
}

/**
 * Splits a view by sales channel. Only worth showing once more than one
 * channel is connected, so the caller decides whether to render it at all.
 */
export function ChannelFilter({
  connectedChannels,
  selectedChannel,
  onSelectedChannelChange,
  className,
  showLabel = false,
}: {
  connectedChannels: ConnectedChannel[]
  selectedChannel: Channel
  onSelectedChannelChange: (channel: Channel) => void
  className?: string
  showLabel?: boolean
}) {
  const options: { value: Channel; label: string }[] = [
    { value: "all", label: "All channels" },
    ...channelOrder
      .filter((channel) => connectedChannels.includes(channel))
      .map((channel) => ({
        value: channel as Channel,
        label: channelLabel(channel),
      })),
  ]

  return (
    <FilterPill
      label={showLabel ? "Channel" : undefined}
      value={selectedChannel}
      options={options}
      onSelect={onSelectedChannelChange}
      className={className}
    />
  )
}
