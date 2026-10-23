import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { McpError, ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createToolDispatcher, defineValidatedTool, ToolFailure } from "../src/index.js";

function payload(result: CallToolResult) {
  assert.equal(result.content.length, 1);
  const text = result.content[0];
  assert.equal(text.type, "text");
  if (text.type !== "text") throw new Error("Expected text content");
  assert.deepEqual(JSON.parse(text.text), result.structuredContent);
  assert.equal(result.isError, !(result.structuredContent!.result as { ok: boolean }).ok);
  return result.structuredContent as { tool: string; result: { ok: boolean; data?: unknown; error?: { code: string; message: string; retryable: boolean; issues?: unknown } } };
}

function calculator(execute: (args: { quantity: number }) => unknown) {
  return defineValidatedTool({
    name: "calculate",
    description: "Test calculator",
    input: z.object({ quantity: z.number().int().positive() }).strict(),
    output: z.object({ total: z.number().int() }).strict(),
    execute: execute as (args: { quantity: number }) => { total: number },
  });
}

test("invalid inputs preserve a structured envelope without calling the executor", async () => {
  let calls = 0;
  const tool = calculator(() => { calls++; return { total: 10 }; });
  const result = payload(await tool.invoke({ quantity: -1 }));
  assert.equal(calls, 0);
  assert.equal(result.tool, "calculate");
  assert.equal(result.result.error?.code, "INVALID_ARGUMENTS");
  assert.deepEqual(result.result.error?.issues, [{ code: "too_small", path: ["quantity"] }]);
});

test("success validates output and produces matching text/structured content", async () => {
  const tool = calculator(({ quantity }) => ({ total: quantity * 100 }));
  assert.deepEqual(payload(await tool.invoke({ quantity: 2 })), {
    tool: "calculate", result: { ok: true, data: { total: 200 } },
  });
  assert.equal(tool.definition.inputSchema.type, "object");
  assert.equal(tool.definition.outputSchema?.type, "object");
});

test("validation errors do not echo raw input or custom Zod messages", async () => {
  const secret = "private-token-do-not-echo";
  const tool = defineValidatedTool({
    name: "check", description: "Check a fixed field",
    input: z.object({ value: z.string().min(100, `secret=${secret}`) }),
    output: z.object({ accepted: z.boolean() }),
    execute: () => ({ accepted: true }),
  });
  const result = await tool.invoke({ value: secret });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(payload(result).result.error?.issues, [{ code: "too_small", path: ["value"] }]);
});

test("application-owned recovery messages remain structured", async () => {
  const tool = calculator(() => {
    throw new ToolFailure({ code: "STALE_STATE", message: "Refresh canonical state.", retryable: false });
  });
  assert.deepEqual(payload(await tool.invoke({ quantity: 1 })).result.error, {
    code: "STALE_STATE", message: "Refresh canonical state.", retryable: false,
  });
});

test("unexpected executor errors are sanitized and cannot invite blind write retries", async () => {
  const tool = calculator(() => { throw new Error("database-password=secret"); });
  const result = await tool.invoke({ quantity: 1 });
  assert.equal(JSON.stringify(result).includes("database-password"), false);
  assert.equal(payload(result).result.error?.code, "INTERNAL_ERROR");
  assert.equal(payload(result).result.error?.retryable, false);
});

test("exceptions thrown by asynchronous input refinements are sanitized before execution", async () => {
  let executions = 0;
  const secret = "private-refinement-token-do-not-echo";
  const tool = defineValidatedTool({
    name: "refined", description: "Check a trusted fixed schema",
    input: z.object({ value: z.string().superRefine(async () => { throw new Error(secret); }) }),
    output: z.object({ accepted: z.boolean() }),
    execute: () => { executions++; return { accepted: true }; },
  });
  const result = await tool.invoke({ value: "anything" });
  assert.equal(executions, 0);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(payload(result).result.error?.code, "INTERNAL_ERROR");
  assert.equal(payload(result).result.error?.retryable, false);
});

test("invalid executor output never escapes as successful data", async () => {
  const tool = calculator(() => ({ total: "not-a-number", credential: "secret" }));
  const result = await tool.invoke({ quantity: 1 });
  assert.equal(payload(result).result.error?.code, "INVALID_OUTPUT");
  assert.equal(JSON.stringify(result).includes("credential"), false);
});

test("validation issue lists are bounded", async () => {
  const tool = defineValidatedTool({
    name: "many", description: "Check an integer array",
    input: z.object({ values: z.array(z.number().int()) }),
    output: z.object({ count: z.number() }),
    execute: ({ values }) => ({ count: values.length }),
  });
  const result = payload(await tool.invoke({ values: Array(100).fill("bad") }));
  assert.equal((result.result.error?.issues as unknown[]).length, 20);
});

test("omitted arguments become an empty object for no-input tools", async () => {
  const tool = defineValidatedTool({
    name: "status", description: "Read status", input: z.object({}).strict(),
    output: z.object({ ready: z.boolean() }), execute: () => ({ ready: true }),
  });
  const result = await createToolDispatcher([tool])({ method: "tools/call", params: { name: "status" } });
  assert.equal(payload(result).result.ok, true);
});

test("unknown and prototype-like names stay protocol errors", async () => {
  const dispatch = createToolDispatcher([calculator(() => ({ total: 1 }))]);
  for (const name of ["missing", "toString", "__proto__"]) {
    await assert.rejects(dispatch({ method: "tools/call", params: { name } }),
      (error: unknown) => error instanceof McpError && error.code === ErrorCode.InvalidParams);
  }
});

test("duplicate tools are rejected rather than silently replacing a handler", () => {
  const tool = calculator(() => ({ total: 1 }));
  assert.throws(() => createToolDispatcher([tool, tool]), /Duplicate tool name/);
});
