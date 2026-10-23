import {
  ErrorCode,
  McpError,
  ToolSchema,
  type CallToolRequest,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const issueSchema = z.object({
  code: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
});
const recoverySchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  issues: z.array(issueSchema).optional(),
});

export type Recovery = z.infer<typeof recoverySchema>;
export type ToolEnvelope<Data> = {
  tool: string;
  result: { ok: true; data: Data } | { ok: false; error: Recovery };
};

/** An intentionally public, application-owned recovery message. Never pass raw exceptions. */
export class ToolFailure extends Error {
  readonly recovery: Recovery;
  constructor(recovery: Recovery) {
    super(recovery.message);
    this.name = "ToolFailure";
    this.recovery = recoverySchema.parse(recovery);
  }
}

export interface ValidatedTool {
  readonly definition: Tool;
  invoke(input: unknown): Promise<CallToolResult>;
}

export interface ToolOptions<Input extends z.ZodObject, Output extends z.ZodObject> {
  name: string;
  description: string;
  input: Input;
  output: Output;
  annotations?: Tool["annotations"];
  execute(args: z.output<Input>): z.input<Output> | Promise<z.input<Output>>;
}

function summarizeIssues(error: z.ZodError): Recovery["issues"] {
  // Do not expose input values, Zod custom messages or raw execution errors.
  // Paths describe schema fields. Dynamic record keys may still identify data;
  // use fixed object schemas or redact those keys before public exposure.
  return error.issues.slice(0, 20).map((issue) => ({
    code: issue.code,
    path: issue.path
      .slice(0, 20)
      .map((part) => typeof part === "number" ? part : String(part).slice(0, 100)),
  }));
}

function encode<Data>(payload: ToolEnvelope<Data>): CallToolResult {
  // A single serialization keeps text and structured content in agreement.
  const text = JSON.stringify(payload);
  return {
    isError: !payload.result.ok,
    structuredContent: JSON.parse(text) as Record<string, unknown>,
    content: [{ type: "text", text }],
  };
}

/** Validate inside a low-level MCP handler, preserving the same envelope on every tool outcome. */
export function defineValidatedTool<Input extends z.ZodObject, Output extends z.ZodObject>(
  options: ToolOptions<Input, Output>,
): ValidatedTool {
  const envelope = z.object({
    tool: z.literal(options.name),
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), data: options.output }),
      z.object({ ok: z.literal(false), error: recoverySchema }),
    ]),
  });
  const definition = ToolSchema.parse({
    name: options.name,
    description: options.description,
    inputSchema: z.toJSONSchema(options.input, { target: "draft-7", io: "input" }),
    outputSchema: z.toJSONSchema(envelope, { target: "draft-7", io: "output" }),
    ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
  });

  const fail = (error: Recovery) => encode({
    tool: options.name,
    result: { ok: false, error },
  });
  return {
    definition,
    async invoke(input) {
      try {
        const parsed = await options.input.safeParseAsync(input);
        if (!parsed.success) {
          return fail({
            code: "INVALID_ARGUMENTS",
            message: "Check the tool input schema and correct the listed fields.",
            retryable: false,
            issues: summarizeIssues(parsed.error),
          });
        }
        const output = await options.output.safeParseAsync(await options.execute(parsed.data));
        if (!output.success) {
          return fail({
            code: "INVALID_OUTPUT",
            message: "The tool result failed its declared output schema. Reconcile state before retrying.",
            retryable: false,
          });
        }
        // Serialize here, inside the guarded section. Non-JSON output cannot
        // escape as a protocol error or expose the executor's raw exception.
        return encode({ tool: options.name, result: { ok: true, data: output.data } });
      } catch (error) {
        return fail(error instanceof ToolFailure ? error.recovery : {
          code: "INTERNAL_ERROR",
          message: "The operation could not be verified. Reconcile state before retrying.",
          retryable: false,
        });
      }
    },
  };
}

/** Unknown tools remain protocol errors; known tools own argument/error validation. */
export function createToolDispatcher(tools: readonly ValidatedTool[]) {
  const byName = new Map<string, ValidatedTool>();
  for (const tool of tools) {
    if (byName.has(tool.definition.name)) {
      throw new Error(`Duplicate tool name: ${tool.definition.name}`);
    }
    byName.set(tool.definition.name, tool);
  }
  return async (request: CallToolRequest): Promise<CallToolResult> => {
    const tool = byName.get(request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
    return tool.invoke(request.params.arguments ?? {});
  };
}
