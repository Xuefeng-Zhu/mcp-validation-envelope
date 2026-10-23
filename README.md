# mcp-validation-envelope

A small TypeScript helper for MCP tools that need the **same structured recovery envelope for invalid arguments, successful results and execution failures**.

Uses the official MCP TypeScript SDK's low-level `Server` and Zod. It adds no web server, database, model provider, authentication layer or retry loop. MIT licensed.

## Why this exists

While building [SayGo](https://github.com/Xuefeng-Zhu/SayGo), an ordering app, we needed clients to recover deterministically from invalid tool arguments. The application's high-level SDK integration returned a text-only validation error before its handler could build the application's structured recovery result. We used the official low-level `Server` to own input validation inside `tools/call` and keep protocol failures separate from known-tool failures.

This repository extracts and generalizes that boundary into a standalone helper. It is an additional project, independent of SayGo's app, DynamoDB and voice code. The originating implementation is [`apps/runtime/src/mcp.ts` at commit `42e8d43`](https://github.com/Xuefeng-Zhu/SayGo/blob/42e8d43f64934da1506af6993d7a1e160d65cb48/apps/runtime/src/mcp.ts), with recovery helpers in [`mcp-results.ts`](https://github.com/Xuefeng-Zhu/SayGo/blob/42e8d43f64934da1506af6993d7a1e160d65cb48/apps/runtime/src/mcp-results.ts). The [friction record](https://github.com/Xuefeng-Zhu/SayGo/blob/main/docs/submission/friction-log.md) describes the observed integration behavior. This is an application-specific recovery pattern, not a claim that all high-level SDK versions have a universal defect.

## Run it

Requires Node.js **22.12 or later**. The lockfile pins MCP SDK **1.32.1**, Zod **4.6.5**, TypeScript and test tooling.

```sh
git clone https://github.com/Xuefeng-Zhu/mcp-validation-envelope.git
cd mcp-validation-envelope
npm ci
npm run check
npm run example
```

The example connects a real SDK client and server using `InMemoryTransport`. It first sends a negative quantity, then corrects it. No account, credentials, AWS service, network listener or paid model is needed. `npm run build` emits ESM JavaScript and TypeScript declarations to `dist/`.

This repository is the distribution source; it has not been published to npm. To use a local checkout in another project, run `npm pack` and install the generated `.tgz` with `npm install /absolute/path/to/mcp-validation-envelope-0.1.0.tgz`.

## Use with a low-level server

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createToolDispatcher,
  defineValidatedTool,
  ToolFailure,
} from "mcp-validation-envelope";

const total = defineValidatedTool({
  name: "calculate_total",
  description: "Calculate a fictional item total in integer cents.",
  input: z.object({
    quantity: z.number().int().positive(),
    unit_cents: z.number().int().nonnegative(),
  }).strict(),
  output: z.object({ total_cents: z.number().int().nonnegative() }).strict(),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute: ({ quantity, unit_cents }) => ({
    total_cents: quantity * unit_cents,
  }),
});

const server = new Server(
  { name: "totals", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [total.definition],
}));
server.setRequestHandler(
  CallToolRequestSchema,
  createToolDispatcher([total]),
);
// Connect the SDK transport appropriate for your application.
```

`defineValidatedTool` accepts trusted object input/output schemas and an executor. JSON Schemas are generated once when the tool is defined; unsupported schema constructs fail at startup as developer configuration errors. `execute` receives Zod's parsed output, so supported defaults and coercions are applied before application logic. Exceptions thrown by an input refinement are caught and sanitized before the executor runs.

For invalid arguments the executor is skipped, `isError` is `true`, and both `structuredContent` and JSON text contain:

```json
{
  "tool": "calculate_total",
  "result": {
    "ok": false,
    "error": {
      "code": "INVALID_ARGUMENTS",
      "message": "Check the tool input schema and correct the listed fields.",
      "retryable": false,
      "issues": [{ "code": "too_small", "path": ["quantity"] }]
    }
  }
}
```

Success uses the same outer shape, with `result: { ok: true, data: ... }` and `isError: false`. Output is validated before success is returned. `retryable: false` means the helper does not authorize an identical blind retry; a client may correct invalid input and make a new application-level request.

Throw an explicit `ToolFailure` only for messages you intend clients to see:

```ts
throw new ToolFailure({
  code: "STALE_STATE",
  message: "Refresh canonical state before changing this record.",
  retryable: false,
});
```

An unexpected exception becomes `INTERNAL_ERROR`; an invalid executor result becomes `INVALID_OUTPUT`. Neither includes the exception, stack, raw output or input values. Recovery issue summaries contain only code and schema path, capped at 20 issues and 20 path components. Custom Zod messages are omitted. **Paths can still contain dynamic record keys**: use fixed object schemas or redact those keys before exposing results publicly. A `ToolFailure` is deliberately public and must never be constructed from raw provider/database exceptions.

An unknown tool throws the SDK's `McpError(InvalidParams)`, preserving the distinction between protocol errors and failures of a known tool. The helper does not put JSON-RPC IDs into result data: the SDK owns request/response correlation. Its transport tests verify those IDs survive successful, invalid-argument and unknown-tool calls.

## Verification and scope

The tests use Node's built-in test runner and the real MCP SDK client/server. They cover execution exclusion on invalid input, matching structured/text results, output validation, explicit recovery errors, redaction, bounded issue summaries, duplicate/prototype-like tool names and JSON-RPC correlation. Client `listTools` discovers the generated schemas before calls, allowing the SDK's output validator to check results against the advertised envelope.

The included example and roundtrip test use **in-memory transport**. They establish the tool/result boundary; they do not claim Streamable HTTP transport, production authentication, concurrency, a live model, idempotency or customer consent. The same official low-level server can be connected to other SDK transports, which your application must configure and test separately. The SDK marks `Server` as an advanced API and recommends `McpServer` for ordinary use; this package deliberately uses that advanced API to control validation recovery.

`npm run check` runs TypeScript checking and the test suite. `npm run example` shows both invalid and corrected calls. See [LICENSE](LICENSE) for reuse terms.
