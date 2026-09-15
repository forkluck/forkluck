// Synthetic OpenAI-compatible endpoint for public CI. No provider, private
// prompt, production credential, or private repository is used by this server.
import { createServer } from "node:http"

const port = Number(process.env.FORKLUCK_ACCEPTANCE_PRIMO_PORT || 9124)
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
const response = (text) => ({
  id: "synthetic-completion",
  model: "primo",
  created: 1,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    },
  ],
  usage,
})
const chunk = (delta, reason = null) => ({
  id: "synthetic-completion",
  model: "primo",
  created: 1,
  choices: [{ index: 0, delta, finish_reason: reason }],
})
const draft = {
  title: "Gateway soup",
  description: "Synthetic acceptance recipe.",
  yield: { amount: 1, unit: "pcs" },
  ingredients: [
    { name: "Flour", quantity: 200, unit: "g", preparation: "" },
    { name: "Water", quantity: 120, unit: "g", preparation: "" },
  ],
  steps: ["Mix the ingredients."],
}
const server = createServer(async (request, reply) => {
  if (request.url === "/healthz") {
    reply.end("ok")
    return
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    reply.writeHead(404)
    reply.end()
    return
  }
  if (request.headers.authorization !== "Bearer synthetic-acceptance-only") {
    reply.writeHead(401)
    reply.end()
    return
  }
  try {
    const parts = []
    for await (const part of request) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString())
    if (
      body.model !== "primo" ||
      body.primo_context?.version !== 1 ||
      !body.primo_context.userId ||
      body.messages.some((message) =>
        ["system", "developer"].includes(message.role)
      )
    )
      throw new Error("Invalid public gateway request")
    const task = body.primo_context.task
    if (task === "title" || task === "vision") {
      reply.writeHead(200, { "Content-Type": "application/json" })
      reply.end(
        JSON.stringify(
          response(
            task === "title"
              ? "Synthetic kitchen chat"
              : "Synthetic photo recipe. Flour 200 g. Water 120 g. Mix the ingredients."
          )
        )
      )
      return
    }
    if (
      body.messages.some((message) =>
        String(message.content).includes("Gateway outage")
      )
    ) {
      reply.writeHead(503, { "Content-Type": "application/json" })
      reply.end(
        JSON.stringify({ error: { message: "Synthetic gateway outage" } })
      )
      return
    }
    const finishedTool = body.messages.some(
      (message) => message.role === "tool"
    )
    const prompt = String(
      body.messages.findLast((message) => message.role === "user")?.content ??
        ""
    )
    const results = body.messages
      .filter((message) => message.role === "tool")
      .map((message) => JSON.parse(message.content))
    let requestedTool
    if (prompt.includes("Draft revision fixture") && !finishedTool)
      requestedTool = {
        name: "draft_recipe",
        input: {
          title: "Synthetic butter cookies",
          description: "Source: Synthetic.txt. Check the oven temperature.",
          yield: { amount: 24, unit: "pcs" },
          ingredients: [
            { name: "Flour", quantity: 300, unit: "g", preparation: "sifted" },
            {
              name: "Butter",
              quantity: 200,
              unit: "g",
              preparation: "softened",
            },
            { name: "Sugar", quantity: 100, unit: "g", preparation: "" },
            {
              name: "Salt",
              quantity: 2,
              unit: "g",
              preparation: "check amount",
            },
          ],
          steps: [
            "Cream butter and sugar.",
            "Mix in flour.",
            "Stir in salt.",
            "Bake at 175 C for 12 minutes.",
          ],
        },
      }
    if (
      prompt.includes("Halve revision fixture") ||
      prompt.includes("Salt revision fixture")
    ) {
      if (!finishedTool)
        requestedTool = { name: "read_recipe_draft", input: {} }
      else if (!results.at(-1)?.changes)
        requestedTool = {
          name: "revise_recipe_draft",
          input: {
            draftId: results.at(-1)?.draftId,
            ...(prompt.includes("Halve")
              ? { yieldAmount: 12 }
              : { ingredientChanges: [{ index: 3, quantity: 1.5 }] }),
          },
        }
    }
    if (!finishedTool && prompt.includes("Calculate batch fixture"))
      requestedTool = {
        name: "calculate_batch_cost",
        input: {
          portions: 24,
          ingredientCostPerBatch: 18,
          packagingCostPerPortion: 0.25,
          sellingPricePerPortion: 2.5,
          ingredientChangePercent: 20,
          currencyCode: "USD",
        },
      }
    if (!finishedTool && prompt.includes("Which three products"))
      requestedTool = {
        name: "get_top_products",
        input: { period: "2026-08", limit: 3 },
      }
    if (!finishedTool && prompt.includes("What changed in ingredient costs?"))
      requestedTool = {
        name: "get_ingredient_price_changes",
        input: { period: "2026-08" },
      }
    const fixtureEvents = requestedTool
      ? [
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `fixture-${requestedTool.name}`,
                type: "function",
                function: {
                  name: requestedTool.name,
                  arguments: JSON.stringify(requestedTool.input),
                },
              },
            ],
          }),
          chunk({}, "tool_calls"),
        ]
      : null
    const events =
      fixtureEvents ??
      (finishedTool
        ? [
            chunk({
              content:
                "The recipe draft is ready to review. Nothing has been saved.",
            }),
            chunk({}, "stop"),
          ]
        : [
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: "draft-gateway-1",
                  type: "function",
                  function: {
                    name: "draft_recipe",
                    arguments: JSON.stringify(draft),
                  },
                },
              ],
            }),
            chunk({}, "tool_calls"),
          ])
    events.push({ ...chunk({}), choices: [], usage })
    reply.writeHead(200, {
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    })
    reply.end(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
        "data: [DONE]\n\n"
    )
  } catch {
    reply.writeHead(400)
    reply.end("Invalid synthetic request")
  }
})
server.listen(port, "127.0.0.1")
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => server.close())
