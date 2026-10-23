import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createToolDispatcher, defineValidatedTool } from "mcp-validation-envelope";

const calculate = defineValidatedTool({
  name: "calculate_total",
  description: "Calculate a fictional item total in integer cents.",
  input: z.object({ quantity: z.number().int().positive(), unit_cents: z.number().int().nonnegative() }).strict(),
  output: z.object({ total_cents: z.number().int().nonnegative() }).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  execute: ({ quantity, unit_cents }) => ({ total_cents: quantity * unit_cents }),
});
const server = new Server({ name: "envelope-example", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [calculate.definition] }));
server.setRequestHandler(CallToolRequestSchema, createToolDispatcher([calculate]));
const client = new Client({ name: "example-client", version: "0.1.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  await client.listTools();
  console.log("Invalid input (executor does not run):");
  console.log(JSON.stringify(await client.callTool({ name: "calculate_total", arguments: { quantity: -1, unit_cents: 499 } }), null, 2));
  console.log("Corrected input:");
  console.log(JSON.stringify(await client.callTool({ name: "calculate_total", arguments: { quantity: 2, unit_cents: 499 } }), null, 2));
} finally {
  await client.close();
  await server.close();
}
