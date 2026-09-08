/**
 * What every auth screen shares, so signing up, signing in, resetting a
 * password and subscribing read as one place. Class strings rather than
 * components, the way `inputClassName` is, so each screen keeps its own
 * element and copy.
 */

/** The centred 17px title a screen opens with. */
export const authHeadingClassName =
  "text-center text-xl leading-6 font-semibold tracking-[-0.01em]"

/** The centred 14px line under a title that has something to say. */
export const authSubtitleClassName =
  "mt-2 text-center text-md leading-5 text-muted-foreground"

/** The centred 13px line under the button that switches screens. */
export const authSwitchClassName =
  "mt-6 text-center text-sm leading-5 text-muted-foreground"

/**
 * The ink link inside it: medium weight, no underline, lifting to the soft
 * ink on hover the way the primary button does. Focus draws the underline
 * instead of a ring, like the wordmark.
 */
export const authLinkClassName =
  "rounded-sm font-medium text-foreground transition-colors outline-none hover:text-ink-soft focus-visible:underline focus-visible:underline-offset-4"
