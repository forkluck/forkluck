// Synthetic OpenAI-compatible endpoint for public CI. No provider, private
// prompt, production credential, or private repository is used by this server.
import { createServer } from "node:http"

const port = Number(process.env.FORKLUCK_ACCEPTANCE_PRIMO_PORT || 9124)
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
const response = text => ({ id: "synthetic-completion", model: "primo", created: 1, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage })
const chunk = (delta, reason = null) => ({ id: "synthetic-completion", model: "primo", created: 1, choices: [{ index: 0, delta, finish_reason: reason }] })
const draft = { title: "Gateway soup", description: "Synthetic acceptance recipe.", yield: { amount: 1, unit: "pcs" }, ingredients: [{ name: "Flour", quantity: 200, unit: "g", preparation: "" }, { name: "Water", quantity: 120, unit: "g", preparation: "" }], steps: ["Mix the ingredients."] }
const server = createServer(async (request, reply) => {
  if (request.url === "/healthz") { reply.end("ok"); return }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") { reply.writeHead(404); reply.end(); return }
  if (request.headers.authorization !== "Bearer synthetic-acceptance-only") { reply.writeHead(401); reply.end(); return }
  try {
    const parts = []
    for await (const part of request) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString())
    if (body.model !== "primo" || body.primo_context?.version !== 1 || !body.primo_context.userId || body.messages.some(message => ["system", "developer"].includes(message.role))) throw new Error("Invalid public gateway request")
    const task = body.primo_context.task
    if (task === "title" || task === "vision") {
      reply.writeHead(200, { "Content-Type": "application/json" })
      reply.end(JSON.stringify(response(task === "title" ? "Synthetic kitchen chat" : "Synthetic photo recipe. Flour 200 g. Water 120 g. Mix the ingredients.")))
      return
    }
    if (body.messages.some(message => String(message.content).includes("Gateway outage"))) {
      reply.writeHead(503, { "Content-Type": "application/json" })
      reply.end(JSON.stringify({ error: { message: "Synthetic gateway outage" } }))
      return
    }
    const finishedTool = body.messages.some(message => message.role === "tool")
    const events = finishedTool
      ? [chunk({ content: "The recipe draft is ready to review. Nothing has been saved." }), chunk({}, "stop")]
      : [chunk({ tool_calls: [{ index: 0, id: "draft-gateway-1", type: "function", function: { name: "draft_recipe", arguments: JSON.stringify(draft) } }] }), chunk({}, "tool_calls")]
    events.push({ ...chunk({}), choices: [], usage })
    reply.writeHead(200, { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" })
    reply.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n")
  } catch { reply.writeHead(400); reply.end("Invalid synthetic request") }
})
server.listen(port, "127.0.0.1")
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close())
