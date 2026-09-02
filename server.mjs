#!/usr/bin/env node
/**
 * AutoDL.art ComfyUI MCP server (zero-dep Node 20 stdio).
 * JSON-RPC 2.0 with LSP-style Content-Length framing.
 * Logs go to stderr only. Never print AUTODL_TOKEN.
 */

import { Buffer } from "node:buffer";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "autodl-comfyui", version: "0.1.1" };
const BASE = "https://autodl.art";
const HTTP_TIMEOUT_MS = 60_000;
const MAX_ERROR_BODY = 12_000;
const WAIT_DEFAULT_TIMEOUT_MS = 45_000;
const WAIT_DEFAULT_INTERVAL_MS = 2_000;
const WAIT_MAX_TIMEOUT_MS = 55_000;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function log(...parts) {
  process.stderr.write(parts.map(String).join(" ") + "\n");
}

function redact(value) {
  const token = process.env.AUTODL_TOKEN;
  const text = value == null ? "" : String(value);
  if (!token) return text;
  return text.split(token).join("[redacted]");
}

function sendMessage(obj) {
  const body = JSON.stringify(obj);
  const payload = Buffer.from(body, "utf8");
  const header = Buffer.from(
    `Content-Length: ${payload.length}\r\n\r\n`,
    "utf8",
  );
  process.stdout.write(Buffer.concat([header, payload]));
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const err = { code, message: redact(message) };
  if (data !== undefined) err.data = data;
  sendMessage({ jsonrpc: "2.0", id, error: err });
}

function toolResult(text, isError = false) {
  return {
    content: [{ type: "text", text: redact(text) }],
    isError,
  };
}

function toolJson(obj, isError = false) {
  return toolResult(JSON.stringify(obj, null, 2), isError);
}

class ToolError extends Error {
  constructor(message, payload) {
    super(message);
    this.name = "ToolError";
    this.payload = payload;
  }
}

function missingTokenResult() {
  return toolResult(
    "AUTODL_TOKEN is not set. Set the AUTODL_TOKEN environment variable to your ComfyUI group token from autodl.art 令牌管理 (token management). Do not paste the token into chat.",
    true,
  );
}

function unwrapData(payload) {
  if (payload && typeof payload === "object" && payload.data && typeof payload.data === "object") {
    return payload.data;
  }
  return payload && typeof payload === "object" ? payload : {};
}

function normalizeStatus(status) {
  if (status == null || status === "") return status;
  const u = String(status).trim().toUpperCase();
  if (u === "COMPLETED" || u === "COMPLETE" || u === "DONE") return "SUCCESS";
  if (u === "FAILURE" || u === "FAIL" || u === "ERROR") return "FAILED";
  if (u === "QUEUED" || u === "RUNNING" || u === "SUCCESS" || u === "FAILED") return u;
  return status;
}

function sanitizePayload(payload) {
  try {
    const text = redact(JSON.stringify(payload));
    return JSON.parse(text);
  } catch {
    return { error: redact(String(payload)) };
  }
}

async function autodlFetch(method, path, body) {
  const token = process.env.AUTODL_TOKEN;
  const url = BASE + path;
  let res;
  try {
    const headers = {
      Authorization: token,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const init = {
      method,
      headers,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    res = await fetch(url, init);
  } catch (err) {
    throw new ToolError(
      `HTTP request failed: ${err && err.name ? err.name : "Error"}: ${redact(err && err.message)}`,
    );
  }

  const raw = await res.text();
  const clipped =
    raw.length > MAX_ERROR_BODY ? raw.slice(0, MAX_ERROR_BODY) + "…[truncated]" : raw;
  if (!res.ok) {
    throw new ToolError(`HTTP ${res.status}: ${redact(clipped)}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ToolError(`HTTP ${res.status} returned non-JSON body: ${redact(clipped)}`);
  }
}

const TOOLS = [
  {
    name: "list_workflows",
    description:
      "List AutoDL.art ComfyUI API workflows. POST { page_index, page_size } and pages automatically if result_total exceeds page_size (max 20 pages). Returns { total, workflows: [{ uuid, name, price_type, usage_count_7d }] }. Use this when the user wants all workflows or does not know the workflow id; then call get_workflow(uuid) for input_rules. Do not invent catalog ids.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: {
        page_index: {
          type: "integer",
          minimum: 1,
          default: 1,
          description: "1-based page index (default 1). Remaining pages are fetched if result_total > page_size.",
        },
        page_size: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 100,
          description: "Page size posted to the API (default 100, max 100).",
        },
      },
    },
  },
  {
    name: "get_workflow",
    description:
      "Fetch a ComfyUI workflow definition from AutoDL.art. Returns ComfyUiWorkflow { uuid, name, description, input_rules, input_example }. Call this before submit_job and copy input_rules keys exactly — never invent body keys.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      required: ["workflow_id"],
      properties: {
        workflow_id: {
          type: "string",
          minLength: 1,
          description: "Workflow id, e.g. minimax_h3_image_audio_to_video_v2_15s",
        },
      },
    },
  },
  {
    name: "submit_job",
    description:
      "Submit a ComfyUI workflow job. POST the inputs object as the JSON body (not wrapped). Inputs keys MUST come from that workflow's input_rules (call get_workflow first). Returns ComfyUiJob { task_id, workflow_id, status, message?, created_at? }. Does not wait for completion.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      required: ["workflow_id", "inputs"],
      properties: {
        workflow_id: {
          type: "string",
          minLength: 1,
          description: "Workflow id from AutoDL.art",
        },
        inputs: {
          type: "object",
          description:
            "Request body posted as-is. Keys must match the workflow's input_rules. Do not wrap or add extra fields.",
        },
      },
    },
  },
  {
    name: "get_job",
    description:
      "Snapshot a ComfyUI job by task_id. Returns ComfyUiJob { task_id, status, duration, results, started_at?, created_at? }. status is QUEUED | RUNNING | SUCCESS | FAILED. After submit_job prefer wait_job; use get_job for a single read. On SUCCESS, download result URLs immediately (short TTL).",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      required: ["task_id"],
      properties: {
        task_id: {
          type: "string",
          minLength: 1,
          description: "task_id returned by submit_job",
        },
      },
    },
  },
  {
    name: "wait_job",
    description:
      "Poll a ComfyUI job in-process until SUCCESS or FAILED, or until timeout. Default interval 2000ms, default timeout 45000ms (cap 55000 so the MCP host does not kill the call). Returns ComfyUiJob plus polls, waited_ms, timed_out. After submit_job call this instead of sleeping between get_job. If timed_out is true and status is still QUEUED or RUNNING, call wait_job again. On SUCCESS download result URLs immediately (short TTL).",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      required: ["task_id"],
      properties: {
        task_id: {
          type: "string",
          minLength: 1,
          description: "task_id returned by submit_job",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: 55000,
          default: 45000,
          description: "Max wait in milliseconds (default 45000, cap 55000).",
        },
        interval_ms: {
          type: "integer",
          minimum: 500,
          maximum: 15000,
          default: 2000,
          description: "Poll interval in milliseconds (default 2000).",
        },
      },
    },
  },
];

function asWorkflow(payload, workflow_id) {
  const src = unwrapData(payload);
  const workflow = {
    uuid: src.uuid ?? workflow_id,
    name: src.name ?? null,
    description: src.description ?? null,
    input_rules: src.input_rules ?? null,
    input_example: src.input_example ?? null,
  };
  return workflow;
}

function pickResultItem(item) {
  if (!item || typeof item !== "object") return { url: null, type: null, file_type: null, output_type: null };
  return {
    url: item.url ?? null,
    type: item.type ?? null,
    file_type: item.file_type ?? null,
    output_type: item.output_type ?? null,
  };
}

function asSubmitJob(payload, workflow_id) {
  const src = unwrapData(payload);
  const task_id = src.task_id;
  if (!task_id) {
    throw new ToolError(
      "No task_id in API response",
      sanitizePayload(payload),
    );
  }
  const job = {
    task_id,
    workflow_id: src.workflow_id ?? workflow_id,
    status: normalizeStatus(src.status) ?? null,
  };
  if (src.message != null) job.message = src.message;
  if (src.created_at != null) job.created_at = src.created_at;
  return job;
}

function asJob(payload) {
  const src = unwrapData(payload);
  const results = Array.isArray(src.results) ? src.results.map(pickResultItem) : [];
  const job = {
    task_id: src.task_id ?? null,
    status: normalizeStatus(src.status) ?? null,
    duration: src.duration ?? null,
    results,
  };
  if (src.started_at != null) job.started_at = src.started_at;
  if (src.created_at != null) job.created_at = src.created_at;
  return job;
}

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new ToolError("arguments is not valid JSON");
    }
  }
  if (typeof raw === "object") return raw;
  throw new ToolError("arguments must be an object");
}

function toPageInt(value, fallback, name, min, max) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ToolError(`${name} must be an integer`);
  }
  const i = Math.trunc(n);
  if (i < min) {
    throw new ToolError(`${name} must be >= ${min}`);
  }
  if (max != null && i > max) return max;
  return i;
}

function asWorkflowListItem(item) {
  if (!item || typeof item !== "object") {
    return { uuid: null, name: null, price_type: null, usage_count_7d: null };
  }
  return {
    uuid: item.uuid ?? null,
    name: item.name ?? null,
    price_type: item.price_type ?? null,
    usage_count_7d: item.usage_count_7d ?? null,
  };
}

async function callListWorkflows(args) {
  const pageIndex = toPageInt(args.page_index, 1, "page_index", 1, null);
  const pageSize = toPageInt(args.page_size, 100, "page_size", 1, 100);
  const workflows = [];
  let total = 0;
  let current = pageIndex;
  const maxPages = 20;
  for (let n = 0; n < maxPages; n += 1) {
    const payload = await autodlFetch("POST", "/api/v1/comfyui/workflows", {
      page_index: current,
      page_size: pageSize,
    });
    const data = unwrapData(payload);
    if (data.result_total != null) total = data.result_total;
    else if (data.total != null) total = data.total;
    const list = Array.isArray(data.list) ? data.list : [];
    for (const item of list) workflows.push(asWorkflowListItem(item));
    if (workflows.length >= total) break;
    if (list.length === 0) break;
    if (data.max_page != null && current >= data.max_page) break;
    current += 1;
  }
  return { total, workflows };
}

async function callGetWorkflow(args) {
  const workflow_id = args.workflow_id;
  if (typeof workflow_id !== "string" || !workflow_id.trim()) {
    throw new ToolError("workflow_id is required (string)");
  }
  const payload = await autodlFetch(
    "GET",
    `/api/v1/comfyui/workflows/${encodeURIComponent(workflow_id.trim())}`,
  );
  return asWorkflow(payload, workflow_id.trim());
}

async function callSubmitJob(args) {
  const workflow_id = args.workflow_id;
  let inputs = args.inputs;
  if (typeof workflow_id !== "string" || !workflow_id.trim()) {
    throw new ToolError("workflow_id is required (string)");
  }
  if (typeof inputs === "string") {
    try {
      inputs = JSON.parse(inputs);
    } catch {
      throw new ToolError("inputs must be a JSON object");
    }
  }
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new ToolError("inputs is required (object); keys must come from the workflow input_rules");
  }
  const payload = await autodlFetch(
    "POST",
    `/api/v1/comfyui/comfyui_workflow/${encodeURIComponent(workflow_id.trim())}`,
    inputs,
  );
  return asSubmitJob(payload, workflow_id.trim());
}

async function callGetJob(args) {
  const task_id = args.task_id;
  if (typeof task_id !== "string" || !task_id.trim()) {
    throw new ToolError("task_id is required (string)");
  }
  const payload = await autodlFetch(
    "GET",
    `/api/v1/comfyui/comfyui_workflow/result/${encodeURIComponent(task_id.trim())}`,
  );
  return asJob(payload);
}

async function callWaitJob(args) {
  const task_id = args.task_id;
  if (typeof task_id !== "string" || !task_id.trim()) {
    throw new ToolError("task_id is required (string)");
  }
  const timeoutMs = toPageInt(args.timeout_ms, WAIT_DEFAULT_TIMEOUT_MS, "timeout_ms", 1000, WAIT_MAX_TIMEOUT_MS);
  const intervalMs = toPageInt(args.interval_ms, WAIT_DEFAULT_INTERVAL_MS, "interval_ms", 500, 15_000);
  const started = Date.now();
  let polls = 0;
  let job;
  while (true) {
    job = await callGetJob({ task_id: task_id.trim() });
    polls += 1;
    const status = job.status;
    const elapsed = Date.now() - started;
    if (status === "SUCCESS" || status === "FAILED") {
      return { ...job, polls, waited_ms: elapsed, timed_out: false };
    }
    if (elapsed + intervalMs >= timeoutMs) {
      return { ...job, polls, waited_ms: elapsed, timed_out: true };
    }
    await sleep(intervalMs);
  }
}

async function handleToolsCall(params) {
  if (!process.env.AUTODL_TOKEN) return missingTokenResult();
  const name = params && params.name;
  let args;
  try {
    args = parseArgs(params && params.arguments);
  } catch (err) {
    return toolResult(err.message, true);
  }
  try {
    if (name === "list_workflows") return toolJson(await callListWorkflows(args));
    if (name === "get_workflow") return toolJson(await callGetWorkflow(args));
    if (name === "submit_job") return toolJson(await callSubmitJob(args));
    if (name === "get_job") return toolJson(await callGetJob(args));
    if (name === "wait_job") return toolJson(await callWaitJob(args));
    return toolResult(`Unknown tool: ${name}`, true);
  } catch (err) {
    if (err instanceof ToolError) {
      if (err.payload !== undefined) {
        return toolJson({ error: redact(err.message), payload: err.payload }, true);
      }
      return toolResult(redact(err.message), true);
    }
    return toolResult(`Internal error: ${redact(err && err.message)}`, true);
  }
}

function handleRequest(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    Promise.resolve(handleToolsCall(params || {}))
      .then((result) => sendResult(id, result))
      .catch((err) => {
        log("tools/call failed:", redact(err && err.message));
        sendResult(id, toolResult(`Internal error: ${redact(err && err.message)}`, true));
      });
    return;
  }
  sendError(id, -32601, `Method not found: ${method}`);
}

function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.jsonrpc && msg.jsonrpc !== "2.0") {
    if (msg.id !== undefined) sendError(msg.id, -32600, "Invalid Request: jsonrpc must be 2.0");
    return;
  }
  const method = msg.method;
  if (!method) {
    if (msg.id !== undefined) sendError(msg.id, -32600, "Invalid Request: method required");
    return;
  }
  const isNotification = msg.id === undefined;
  if (method === "notifications/initialized" || method === "initialized") {
    return;
  }
  if (method.startsWith("notifications/")) {
    return;
  }
  if (isNotification) {
    return;
  }
  handleRequest(msg);
}

let buffer = Buffer.alloc(0);

function processBuffer() {
  while (true) {
    const sep = buffer.indexOf("\r\n\r\n");
    if (sep === -1) return;
    const headerText = buffer.subarray(0, sep).toString("utf8");
    const match = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      log("malformed MCP header: missing Content-Length");
      buffer = buffer.subarray(sep + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = sep + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      log("JSON parse error");
      sendError(null, -32700, "Parse error");
      continue;
    }
    try {
      handleMessage(parsed);
    } catch (err) {
      log("handleMessage error:", redact(err && err.message));
      if (parsed && parsed.id !== undefined) {
        sendError(parsed.id, -32603, "Internal error");
      }
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

process.stdin.on("end", () => {
  process.exit(0);
});

process.stdin.on("error", (err) => {
  log("stdin error:", redact(err && err.message));
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  log("uncaughtException:", redact(err && err.message));
});

process.on("unhandledRejection", (err) => {
  log("unhandledRejection:", redact(err && err && err.message));
});

log("autodl-comfyui MCP server listening on stdio");
