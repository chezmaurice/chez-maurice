// Minimal MCP client for the loopback gateway (Streamable HTTP transport).
//
// The Maurice chat tool-loop uses this to list and call the household's MCP
// tools. Auth is the internal static key (MAURICE_MCP_TOKEN); member scope is
// passed per-call via the X-Maurice-Member-Id header, which the gateway's
// MemberContextMiddleware turns into the member_id contextvar.

import { getPort } from "../../data-api/lib/config";

const PROTOCOL_VERSION = "2025-03-26";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: any;
}

function gatewayUrl(): string {
  const port = getPort("mcp-gateway");
  return `http://127.0.0.1:${port}/mcp`;
}

function authHeaders(memberId: string): Record<string, string> {
  const token = process.env.MAURICE_MCP_TOKEN || "";
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "X-Maurice-Member-Id": memberId,
  };
}

/** Where a session talks to, and how. The household's gateway by default;
 *  a member's own server (services/memberTools.ts) brings its own. */
export interface McpEndpoint {
  url: string;
  headers: Record<string, string>;
  /** The fetch to use: the remote case goes through the SSRF guard. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Give up on a request after this long. None for the loopback gateway. */
  timeoutMs?: number;
  /** Read at most this much of an answer. */
  maxBytes?: number;
}

function gatewayEndpoint(memberId: string): McpEndpoint {
  return { url: gatewayUrl(), headers: authHeaders(memberId) };
}

function rpcMessage(payload: string): any {
  try {
    return JSON.parse(payload);
  } catch {
    return null; // a keepalive, or a frame cut short
  }
}

// Parse a Streamable-HTTP response body: either a JSON object, or SSE frames
// where the payload is on `data:` lines. Returns the first JSON-RPC message
// that has a `result` or `error` — and stops reading there: a server that
// keeps its event stream open after answering would otherwise hold the turn.
async function parseRpc(resp: Response, maxBytes = Infinity): Promise<any> {
  const ct = resp.headers.get("content-type") || "";
  const sse = !ct.includes("application/json");
  const reader = resp.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let scanned = 0;
  let last: any = null;
  const scan = (final: boolean): any => {
    for (;;) {
      const nl = text.indexOf("\n", scanned);
      if (nl < 0 && !final) return null;
      const line = (nl < 0 ? text.slice(scanned) : text.slice(scanned, nl)).trim();
      scanned = nl < 0 ? text.length : nl + 1;
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          const msg = rpcMessage(payload);
          if (msg && (msg.result !== undefined || msg.error !== undefined)) return msg;
          if (msg) last = msg;
        }
      }
      if (nl < 0) return null;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Error("the answer is too large");
        text += decoder.decode(value, { stream: true });
      }
      if (sse) {
        const hit = scan(!!done);
        if (hit) return hit;
      }
      if (done) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  if (!sse) return JSON.parse(text);
  return last;
}

/**
 * A short-lived MCP session: initialize once, then list/call tools.
 * Construct via McpSession.open(memberId), or McpSession.openAt(endpoint).
 */
export class McpSession {
  private constructor(
    private endpoint: McpEndpoint,
    private sessionId: string | null,
    private protocol: string | null,
  ) {}

  static open(memberId: string): Promise<McpSession> {
    return McpSession.openAt(gatewayEndpoint(memberId));
  }

  static async openAt(endpoint: McpEndpoint): Promise<McpSession> {
    const fresh = new McpSession(endpoint, null, null);
    const resp = await fresh.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "maurice-server", version: "0.1.0" },
      },
    });
    if (!resp.ok) {
      throw new Error(`MCP initialize failed: ${resp.status} ${(await resp.text().catch(() => "")).slice(0, 300)}`);
    }
    const sessionId = resp.headers.get("mcp-session-id");
    const init = await parseRpc(resp, endpoint.maxBytes);
    if (init?.error) throw new Error(`MCP initialize error: ${init.error.message || JSON.stringify(init.error)}`);
    const version = typeof init?.result?.protocolVersion === "string" ? init.result.protocolVersion : null;

    const session = new McpSession(endpoint, sessionId, version);
    // Required handshake: tell the server we're initialized.
    await session.notify("notifications/initialized");
    return session;
  }

  private send(body: unknown): Promise<Response> {
    const headers = { ...this.endpoint.headers };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (this.protocol) headers["MCP-Protocol-Version"] = this.protocol;
    const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body) };
    if (this.endpoint.timeoutMs) init.signal = AbortSignal.timeout(this.endpoint.timeoutMs);
    return (this.endpoint.fetch ?? fetch)(this.endpoint.url, init);
  }

  private async notify(method: string): Promise<void> {
    await this.send({ jsonrpc: "2.0", method, params: {} })
      .then((r) => r.body?.cancel())
      .catch(() => {});
  }

  private async rpc(method: string, params: any, id: number): Promise<any> {
    const resp = await this.send({ jsonrpc: "2.0", id, method, params });
    if (!resp.ok) {
      throw new Error(`MCP ${method} failed: ${resp.status} ${(await resp.text().catch(() => "")).slice(0, 300)}`);
    }
    const msg = await parseRpc(resp, this.endpoint.maxBytes);
    if (msg?.error) {
      throw new Error(`MCP ${method} error: ${msg.error.message || JSON.stringify(msg.error)}`);
    }
    return msg?.result;
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.rpc("tools/list", {}, 2);
    return (result?.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || t.input_schema || { type: "object" },
    }));
  }

  /** Call a tool; returns its content flattened to a string. */
  async callTool(name: string, args: any): Promise<{ text: string; isError: boolean }> {
    const result = await this.rpc("tools/call", { name, arguments: args || {} }, 3);
    const blocks = result?.content || [];
    const text = blocks
      .map((b: any) => (b?.type === "text" ? b.text : JSON.stringify(b)))
      .join("\n");
    return { text: text || "(no output)", isError: !!result?.isError };
  }
}

/** Convenience: list the member's tools in one shot. */
export async function listMemberTools(memberId: string): Promise<McpTool[]> {
  const s = await McpSession.open(memberId);
  return s.listTools();
}

/**
 * Call a corpus (or any gateway) tool scoped to `memberId` and parse its JSON
 * result. Used by the web admin for the Anthropic-export import flow.
 */
export async function corpusCall(memberId: string, name: string, args: any): Promise<any> {
  const s = await McpSession.open(memberId);
  // The gateway namespaces each sub-server's tools as `<server>__<tool>`.
  const toolName = name.includes("__") ? name : `corpus__${name}`;
  const { text, isError } = await s.callTool(toolName, args);
  if (isError) throw new Error(text || `${toolName} failed`);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Fire-and-forget: ask the corpus tool to reconcile one conversation into the
 * per-member semantic index after a turn completes. The corpus fans out to every
 * participant itself, so a single call (scoped to any participant for gateway auth)
 * is enough. Never throws into the caller; the periodic backfill is the safety net.
 */
export function indexConversationInBackground(memberId: string, conversationId: string): void {
  // Through corpusCall so the name carries the gateway's `corpus__` prefix.
  // Called bare, the gateway answered "Unknown tool" as ordinary text — not an
  // error — and no live conversation reached the index for three months while
  // this reported success.
  corpusCall(memberId, "index_conversation", { conversation_id: conversationId })
    .then((r) => {
      if (r?.error || r?.raw) {
        console.warn(`[corpus] index_conversation(${conversationId}) refused: ${r.error ?? r.raw}`);
      }
    })
    .catch((err) =>
      console.warn(`[corpus] index_conversation(${conversationId}) failed: ${err?.message || err}`)
    );
}
