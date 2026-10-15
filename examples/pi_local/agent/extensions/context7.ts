/**
 * Context7 Tool - Search and query documentation
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function parseSSE(text: string, id: number): any | undefined {
  const lines = text.split(/\r?\n/);
  let dataBuffer = "";
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      dataBuffer += line.substring(6);
    } else if (line.trim() === "") {
      if (dataBuffer) {
        try {
          const parsed = JSON.parse(dataBuffer);
          if (parsed.id === id || (parsed.result && !parsed.id)) {
            return parsed;
          }
        } catch {
          // ignore
        }
        dataBuffer = "";
      }
    }
  }
  if (dataBuffer) {
    try {
      const parsed = JSON.parse(dataBuffer);
      if (parsed.id === id || (parsed.result && !parsed.id)) {
        return parsed;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

function parseResponse(text: string, id: number): any {
  try {
    return JSON.parse(text);
  } catch {
    const sse = parseSSE(text, id);
    if (sse) return sse;
    throw new Error(`Failed to parse response from Context7 API. Raw response: ${text.substring(0, 200)}...`);
  }
}

const MCP_ENDPOINT = "https://mcp.context7.com/mcp";
const MCP_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
};

async function initMCPSession(): Promise<string> {
  const res = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-agent", version: "1.0" },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`MCP initialize failed: HTTP ${res.status}`);
  }

  const sessionId = res.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error("MCP server did not return a session ID");
  }

  // Consume the response body
  await res.text();

  // Send initialized notification
  const notifyRes = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: {
      ...MCP_HEADERS,
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });

  if (!notifyRes.ok) {
    throw new Error(`MCP notification failed: HTTP ${notifyRes.status}`);
  }

  return sessionId;
}

async function callContext7(method: string, args: Record<string, any>) {
  const sessionId = await initMCPSession();

  const res = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: {
      ...MCP_HEADERS,
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: method,
        arguments: args,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const text = await res.text();
  const data = parseResponse(text, 1);

  if (data.error) {
    throw new Error(data.error.message);
  }

  if (!data.result || !data.result.content || !data.result.content[0]) {
    throw new Error("Invalid response from Context7 API");
  }

  return data.result.content[0].text;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "context7-search",
    label: "Context7 Search",
    description: "Resolve a library name to its Context7 ID for documentation queries.",
    parameters: Type.Object({
      libraryName: Type.String({ description: "Library name (e.g. 'react', 'pydantic')" }),
      query: Type.String({ description: "Optional query to narrow library match", default: "" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { libraryName, query } = params as { libraryName: string; query?: string };
      const searchQuery = query || libraryName;

      try {
        const text = await callContext7("resolve-library-id", { query: searchQuery, libraryName });
        return {
          content: [{ type: "text", text }],
          details: { libraryName, query: searchQuery },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          details: { error: error instanceof Error ? error.message : 'Unknown error' },
        };
      }
    },
  });

  pi.registerTool({
    name: "context7-query",
    label: "Context7 Query",
    description: "Query indexed documentation for a library using its Context7 library ID.",
    parameters: Type.Object({
      libraryId: Type.String({ description: "Context7 library ID (e.g. '/websites/react_dev')" }),
      query: Type.String({ description: "Specific question or search term for the docs" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { libraryId, query } = params as { libraryId: string; query: string };

      try {
        const text = await callContext7("query-docs", { libraryId, query });
        return {
          content: [{ type: "text", text }],
          details: { libraryId, query },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          details: { error: error instanceof Error ? error.message : 'Unknown error' },
        };
      }
    },
  });
}
