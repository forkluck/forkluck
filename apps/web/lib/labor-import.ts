export type LaborColumnMap = {
  employee: string
  clockIn: string
  clockOut: string
  duration: string | null
  breaks: string | null
  timeAdjustment: string | null
  earningsAdjustment: string | null
  comment: string | null
}

export type LaborImportEntry = {
  position: number
  employeeName: string
  clockInLocal: string
  clockOutLocal: string
  paidSeconds: number
  breakSeconds: number
  timeAdjustmentSeconds: number
  earningsAdjustmentCents: number
  comment: string
  raw: Record<string, string>
}

export type LaborImportSkippedRow = {
  position: number
  employeeName: string
  reason: string
  raw: Record<string, string>
}

export type LaborImportPerson = {
  name: string
  normalizedName: string
  shiftCount: number
  totalSeconds: number
  firstDate: string
  lastDate: string
}

export type LaborImportPreview = {
  headers: string[]
  mapping: LaborColumnMap
  totalRows: number
  periodStart: string | null
  periodEnd: string | null
  totalSeconds: number
  entries: LaborImportEntry[]
  skipped: LaborImportSkippedRow[]
  people: LaborImportPerson[]
}

type ParseLaborOptions = {
  mapping?: Partial<LaborColumnMap>
}

const COLUMN_PATTERNS: Record<keyof LaborColumnMap, RegExp[]> = {
  employee: [
    /^employee$/,
    /team\s*member/,
    /^staff(?:\s*name)?$/,
    /^worker$/,
    /^job$/,
    /employee\s*name/,
    /^name$/,
  ],
  clockIn: [/clocked\s*in/, /clock\s*in/, /^start(?:ed)?(?:\s*at)?$/],
  clockOut: [/clocked\s*out/, /clock\s*out/, /^end(?:ed)?(?:\s*at)?$/],
  duration: [
    /^duration$/,
    /^paid\s*(?:time|hours)$/,
    /^total\s*(?:time|hours)$/,
    /^hours$/,
  ],
  breaks: [/^breaks?$/, /break\s*(?:time|duration)/],
  timeAdjustment: [/total\s*time\s*adjustment/, /^time\s*adjustment$/],
  earningsAdjustment: [
    /total\s*earnings\s*adjustment/,
    /earnings?\s*adjustment/,
    /pay\s*adjustment/,
  ],
  comment: [/^comments?$/, /^notes?$/, /^description$/],
}

function cleanHeader(value: unknown): string {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
}

function detectedColumn(headers: string[], key: keyof LaborColumnMap) {
  return (
    headers.find((header) =>
      COLUMN_PATTERNS[key].some((pattern) =>
        pattern.test(normalizeHeader(header))
      )
    ) ?? null
  )
}

function mappedColumn(
  headers: string[],
  supplied: Partial<LaborColumnMap> | undefined,
  key: keyof LaborColumnMap
): string | null {
  const value = supplied?.[key]
  if (value === null) return null
  if (typeof value === "string") {
    if (!headers.includes(value))
      throw new Error(`Column "${value}" was not found.`)
    return value
  }
  return detectedColumn(headers, key)
}

function resolveMapping(
  headers: string[],
  supplied?: Partial<LaborColumnMap>
): LaborColumnMap {
  const mapping = {
    employee: mappedColumn(headers, supplied, "employee"),
    clockIn: mappedColumn(headers, supplied, "clockIn"),
    clockOut: mappedColumn(headers, supplied, "clockOut"),
    duration: mappedColumn(headers, supplied, "duration"),
    breaks: mappedColumn(headers, supplied, "breaks"),
    timeAdjustment: mappedColumn(headers, supplied, "timeAdjustment"),
    earningsAdjustment: mappedColumn(headers, supplied, "earningsAdjustment"),
    comment: mappedColumn(headers, supplied, "comment"),
  }
  if (!mapping.employee || !mapping.clockIn || !mapping.clockOut) {
    throw new Error(
      "Choose columns for employee, clock in, and clock out before importing."
    )
  }
  return mapping as LaborColumnMap
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

function localDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0
): string | null {
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day ||
    value.getUTCHours() !== hour ||
    value.getUTCMinutes() !== minute ||
    value.getUTCSeconds() !== second
  ) {
    return null
  }
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`
}

function parseDateTime(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return localDateTime(
      value.getUTCFullYear(),
      value.getUTCMonth() + 1,
      value.getUTCDate(),
      value.getUTCHours(),
      value.getUTCMinutes(),
      value.getUTCSeconds()
    )
  }

  const text = String(value ?? "").trim()
  if (!text) return null

  const american = text.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i
  )
  if (american) {
    const rawYear = Number(american[3])
    const year = rawYear < 100 ? 2000 + rawYear : rawYear
    let hour = Number(american[4]) % 12
    if (american[7].toUpperCase() === "PM") hour += 12
    return localDateTime(
      year,
      Number(american[1]),
      Number(american[2]),
      hour,
      Number(american[5]),
      Number(american[6] ?? 0)
    )
  }

  const isoLike = text.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/
  )
  if (isoLike) {
    return localDateTime(
      Number(isoLike[1]),
      Number(isoLike[2]),
      Number(isoLike[3]),
      Number(isoLike[4]),
      Number(isoLike[5]),
      Number(isoLike[6] ?? 0)
    )
  }
  return null
}

function localTimestamp(value: string): number {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/)
  if (!match) return Number.NaN
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  )
}

function durationSeconds(value: unknown, allowNegative = false): number | null {
  const text = String(value ?? "").trim()
  if (!text) return allowNegative ? 0 : null

  const decimal = text.replaceAll(",", "").match(/^-?\d+(?:\.\d+)?$/)
  if (decimal) {
    const hours = Number(text.replaceAll(",", ""))
    if (!Number.isFinite(hours) || (!allowNegative && hours <= 0)) return null
    return Math.round(hours * 3600)
  }

  const clock = text.match(/^(-?)(\d+):(\d{1,2})(?::(\d{1,2}))?$/)
  if (clock) {
    const sign = clock[1] === "-" ? -1 : 1
    const minutes = Number(clock[3])
    const seconds = Number(clock[4] ?? 0)
    if (minutes > 59 || seconds > 59 || (!allowNegative && sign < 0))
      return null
    return sign * (Number(clock[2]) * 3600 + minutes * 60 + seconds)
  }

  const words = text.match(
    /^(-?)\s*(?:(\d+(?:\.\d+)?)\s*h(?:ours?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?)?$/i
  )
  if (words && (words[2] || words[3])) {
    const sign = words[1] === "-" ? -1 : 1
    if (!allowNegative && sign < 0) return null
    return Math.round(
      sign * (Number(words[2] ?? 0) * 3600 + Number(words[3] ?? 0) * 60)
    )
  }
  return null
}

function moneyCents(value: unknown): number | null {
  let text = String(value ?? "").trim()
  if (!text) return 0
  let negative = false
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true
    text = text.slice(1, -1)
  }
  text = text.replace(/[$,\s]/g, "")
  if (text.startsWith("-")) {
    negative = true
    text = text.slice(1)
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null
  const cents = Math.round(Number(text) * 100)
  return negative ? -cents : cents
}

export function normalizeEmployeeName(value: string): string {
  // toLowerCase, not toLocaleLowerCase: the backend keys the same strings
  // with `group_key_part`, the Python mirror of this exact expression, and
  // the preview joins the browser's key against the server's — see
  // apps/api/forkluck/domains/labor/serializers.py.
  return value.toLowerCase().replace(/\s+/g, " ").trim()
}

function rawRecord(headers: string[], row: unknown[]): Record<string, string> {
  return Object.fromEntries(
    headers.map((header, index) => [header, String(row[index] ?? "").trim()])
  )
}

function cell(raw: Record<string, string>, header: string | null): string {
  return header ? (raw[header] ?? "") : ""
}

function headerRowIndex(
  rows: unknown[][],
  supplied?: Partial<LaborColumnMap>
): number {
  return rows.findIndex((row) => {
    const headers = row.map(cleanHeader).filter(Boolean)
    if (headers.length < 3) return false
    if (
      typeof supplied?.employee === "string" &&
      typeof supplied.clockIn === "string" &&
      typeof supplied.clockOut === "string"
    ) {
      return [supplied.employee, supplied.clockIn, supplied.clockOut].every(
        (header) => headers.includes(header)
      )
    }
    return Boolean(
      detectedColumn(headers, "employee") &&
      detectedColumn(headers, "clockIn") &&
      detectedColumn(headers, "clockOut")
    )
  })
}

export function parseLaborRows(
  rows: unknown[][],
  options: ParseLaborOptions = {}
): LaborImportPreview {
  const foundHeaderIndex = headerRowIndex(rows, options.mapping)
  if (foundHeaderIndex === -1) {
    throw new Error(
      "No hours header row found. The file needs employee, clock-in, and clock-out columns."
    )
  }

  const headers = rows[foundHeaderIndex].map(cleanHeader)
  const mapping = resolveMapping(headers, options.mapping)
  const entries: LaborImportEntry[] = []
  const skipped: LaborImportSkippedRow[] = []
  let totalRows = 0

  rows.slice(foundHeaderIndex + 1).forEach((row, index) => {
    if (!row.some((value) => String(value ?? "").trim())) return
    totalRows += 1
    const position = foundHeaderIndex + index + 2
    const raw = rawRecord(headers, row)
    const employeeName = cell(raw, mapping.employee).replace(/\s+/g, " ").trim()
    const fail = (reason: string) => {
      skipped.push({ position, employeeName, reason, raw })
    }
    if (!employeeName) {
      fail("Employee name is missing")
      return
    }

    const clockInLocal = parseDateTime(cell(raw, mapping.clockIn))
    const clockOutLocal = parseDateTime(cell(raw, mapping.clockOut))
    if (!clockInLocal || !clockOutLocal) {
      fail("Clock-in or clock-out time could not be read")
      return
    }
    const elapsedSeconds = Math.round(
      (localTimestamp(clockOutLocal) - localTimestamp(clockInLocal)) / 1000
    )
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
      fail("Clock-out must be after clock-in")
      return
    }

    const durationValue = cell(raw, mapping.duration)
    const parsedDuration = mapping.duration
      ? durationSeconds(durationValue)
      : elapsedSeconds
    if (parsedDuration === null || parsedDuration <= 0) {
      fail(
        `Paid duration could not be read${durationValue ? `: "${durationValue}"` : ""}`
      )
      return
    }

    const breaksValue = cell(raw, mapping.breaks)
    const breakSeconds = breaksValue ? durationSeconds(breaksValue) : 0
    if (breakSeconds === null || breakSeconds < 0) {
      fail(`Break duration could not be read: "${breaksValue}"`)
      return
    }

    const timeAdjustmentValue = cell(raw, mapping.timeAdjustment)
    const timeAdjustmentSeconds = timeAdjustmentValue
      ? durationSeconds(timeAdjustmentValue, true)
      : 0
    if (timeAdjustmentSeconds === null) {
      fail(`Time adjustment could not be read: "${timeAdjustmentValue}"`)
      return
    }

    const earningsValue = cell(raw, mapping.earningsAdjustment)
    const earningsAdjustmentCents = moneyCents(earningsValue)
    if (earningsAdjustmentCents === null) {
      fail(`Earnings adjustment could not be read: "${earningsValue}"`)
      return
    }

    entries.push({
      position,
      employeeName,
      clockInLocal,
      clockOutLocal,
      paidSeconds: parsedDuration,
      breakSeconds,
      timeAdjustmentSeconds,
      earningsAdjustmentCents,
      comment: cell(raw, mapping.comment).slice(0, 500),
      raw,
    })
  })

  const peopleByName = new Map<string, LaborImportPerson>()
  for (const entry of entries) {
    const normalizedName = normalizeEmployeeName(entry.employeeName)
    const date = entry.clockInLocal.slice(0, 10)
    const current = peopleByName.get(normalizedName)
    if (current) {
      current.shiftCount += 1
      current.totalSeconds += entry.paidSeconds
      if (date < current.firstDate) current.firstDate = date
      if (date > current.lastDate) current.lastDate = date
    } else {
      peopleByName.set(normalizedName, {
        name: entry.employeeName,
        normalizedName,
        shiftCount: 1,
        totalSeconds: entry.paidSeconds,
        firstDate: date,
        lastDate: date,
      })
    }
  }

  const dates = entries.map((entry) => entry.clockInLocal.slice(0, 10)).sort()
  return {
    headers,
    mapping,
    totalRows,
    periodStart: dates[0] ?? null,
    periodEnd: dates.at(-1) ?? null,
    totalSeconds: entries.reduce(
      (total, entry) => total + entry.paidSeconds,
      0
    ),
    entries,
    skipped,
    people: [...peopleByName.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
  }
}
