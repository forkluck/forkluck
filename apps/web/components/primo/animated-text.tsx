"use client"

import * as React from "react"

export function AnimatedText({
  text,
  animate,
}: {
  text: string
  animate: boolean
}) {
  const tokens = text.match(/\S+|\s+/g) ?? []
  const wordCount = tokens.filter((token) => /\S/.test(token)).length
  const [settledCount, setSettledCount] = React.useState(
    animate ? 0 : wordCount
  )
  let wordIndex = 0
  const content = tokens.map((token, index) => {
    if (!/\S/.test(token)) return token
    const current = wordIndex++
    const arriving = animate && current >= settledCount
    return arriving ? (
      <span
        key={index}
        className="primo-word-arrival"
        style={{
          animationDelay: `${Math.min((current - settledCount) * 25, 250)}ms`,
        }}
      >
        {token}
      </span>
    ) : (
      token
    )
  })
  React.useEffect(() => {
    const timeout = window.setTimeout(
      () => setSettledCount(wordCount),
      animate ? 550 : 0
    )
    return () => window.clearTimeout(timeout)
  }, [animate, wordCount])
  return <>{content}</>
}
