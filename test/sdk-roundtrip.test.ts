import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createToolDispatcher, defineValidatedTool } from "../src/index.js";

test("real SDK list/call roundtrip validates errors and successes; JSON-RPC IDs survive", async () => {
  let executions = 0;
  const tool = defineValidatedTool({
    name: "quantity", description: "Return a validated quantity",
    input: z.object({ quantity: z.number().int().positive() }).strict(),
    output: z.object({ quantity: z.number().int().positive() }).strict(),
    execute: (args) => { executions++; return args; },
  });
  const server = new Server({ name: "test-server", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [tool.definition] }));
  server.setRequestHandler(CallToolRequestSchema, createToolDispatcher([tool]));
  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const clientMessages: JSONRPCMessage[] = [];
  const serverMessages: JSONRPCMessage[] = [];
  const clientSend = clientTransport.send.bind(clientTransport);
  const serverSend = serverTransport.send.bind(serverTransport);
  clientTransport.send = async (message, options) => { clientMessages.push(message); return clientSend(message, options); };
  serverTransport.send = async (message, options) => { serverMessages.push(message); return serverSend(message, options); };
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const catalog = await client.listTools();
    assert.equal(catalog.tools[0].name, "quantity");
    assert.equal(catalog.tools[0].outputSchema?.type, "object");
    const invalid = await client.callTool({ name: "quantity", arguments: { quantity: 0 } });
    assert.equal(invalid.isError, true);
    assert.equal(executions, 0);
    assert.deepEqual(invalid.structuredContent, {
      tool: "quantity",
      result: { ok: false, error: {
        code: "INVALID_ARGUMENTS", message: "Check the tool input schema and correct the listed fields.",
        retryable: false, issues: [{ code: "too_small", path: ["quantity"] }],
      } },
    });
    const success = await client.callTool({ name: "quantity", arguments: { quantity: 3 } });
    assert.equal(success.isError, false);
    assert.equal(executions, 1);
    assert.deepEqual(success.structuredContent, { tool: "quantity", result: { ok: true, data: { quantity: 3 } } });
    await assert.rejects(client.callTool({ name: "unknown", arguments: {} }), /Unknown tool/);
    const calls = clientMessages.filter((message) => "method" in message && message.method === "tools/call");
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.ok("id" in call);
      const response = serverMessages.find((message) => "id" in message && message.id === call.id);
      assert.ok(response, `Missing response for JSON-RPC id ${call.id}`);
    }
    const invalidCall = calls[0];
    assert.ok("id" in invalidCall);
    const invalidResponse = serverMessages.find((message) => "id" in message && message.id === invalidCall.id);
    assert.ok(invalidResponse && "result" in invalidResponse);
    const unknownCall = calls[2];
    assert.ok("id" in unknownCall);
    const unknownResponse = serverMessages.find((message) => "id" in message && message.id === unknownCall.id);
    assert.ok(unknownResponse && "error" in unknownResponse);
  } finally {
    await client.close();
    await server.close();
  }
});
