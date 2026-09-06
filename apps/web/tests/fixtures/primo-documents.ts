/** Synthetic positioned PDF pages; no supplier or kitchen operational data. */
export function kitchenPdf(pages: string[][], fontSize = 12): Buffer {
  const font = 3 + pages.length * 2
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  ]
  pages.forEach((lines, index) => {
    const stream = lines
      .map(
        (line, row) =>
          `BT /F1 ${fontSize} Tf 1 0 0 1 30 ${740 - row * 18} Tm (${line.replace(/[\\()]/g, "\\$&")}) Tj ET`
      )
      .join("\n")
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
    )
  })
  bodies.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  let text = "%PDF-1.4\n"
  const offsets: number[] = []
  bodies.forEach((body, index) => {
    offsets.push(Buffer.byteLength(text))
    text += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const start = Buffer.byteLength(text)
  text += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(text)
}

export const invoiceLines = [
  "Synthetic Supplier Invoice",
  "Item          Quantity     Amount",
  "Flour         2 bags       20.00",
  "Butter        1 case       40.00",
  "Total                      60.00",
]
