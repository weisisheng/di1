"use server";

import { ToolDefinition } from "@/lib/tool-definition";
import { Message } from "ai";
import { ai } from "./ai";
import { db } from "./bindings";

export interface Vector {
  id: string;
  metadata?: Record<string, unknown>;
  values?: number[];
}

interface Match {
  id: string;
  metadata: Record<string, unknown>;
  score: number;
  values: number[];
}

interface CloudflareQueryResponse {
  errors: any[];
  messages: any[];
  result: QueryResult;
  success: boolean;
}

interface QueryResult {
  count: number;
  matches: Match[];
}
/**
 * Converts an array of vectors to NDJSON format.
 * @param vectors Array of vectors to convert.
 * @returns NDJSON string.
 */
function vectorsToNDJSON(vectors: VectorizeVector[]): string {
  return vectors.map((vector) => JSON.stringify(vector)).join("\n");
}

interface CloudflareResponse {
  errors: any[];
  messages: any[];
  result: {
    count: number;
    ids: string[];
  };
  success: boolean;
}

/**
 * Sends vectors to Cloudflare for indexing.
 * @param vectors Array of vectors to send.
 * @returns The Cloudflare response or undefined if an error occurs.
 */
export async function sendToCloudflare(
  vectors: VectorizeVector[]
): Promise<CloudflareResponse | undefined> {
  const ndjson = vectorsToNDJSON(vectors);

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/vectorize/indexes/ycindex/upsert`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-ndjson",
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      },
      body: ndjson,
    });
    if (!response.ok) {
      console.error("Error response:", await response.text()); // Log error response
      throw new Error(`Error in vectorize INSERT: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error("Error sending to Cloudflare:", error);
    return undefined;
  }
}

/**
 * Queries Cloudflare for vector matches.
 * @param embeddings The embeddings to query.
 * @param returnMetadata Whether to return metadata in the response.
 * @param returnValues Whether to return values in the response.
 * @param topK The number of top matches to return.
 * @returns Array of matches or undefined if an error occurs.
 */
export async function queryCloudflare(
  embeddings: number[],
  returnMetadata: boolean = false,
  returnValues: boolean = false,
  topK: number = 5
): Promise<Match[] | undefined> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/vectorize/indexes/ycindex/query`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      },
      body: JSON.stringify({
        vector: embeddings,
        returnMetadata,
        returnValues,
        topK,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data: CloudflareQueryResponse = await response.json();

    if (!data.success || !data.result || !data.result.matches) {
      console.error("Invalid response structure:", data);
      return undefined;
    }

    return data.result.matches;
  } catch (error) {
    console.error("Error querying Cloudflare:", error);
    return undefined;
  }
}

interface CloudflareEmbeddingResponse {
  result: {
    shape: [number, number];
    data: number[][];
  };
  success: boolean;
  errors: any[];
  messages: any[];
}

/**
 * Creates embeddings for the given text using Cloudflare's AI API.
 * @param text The text string to create embeddings for.
 * @returns Array of embeddings or undefined if an error occurs.
 */
export async function createEmbeddings(
  text: string
): Promise<number[] | undefined> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/baai/bge-large-en-v1.5`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      },
      body: JSON.stringify({ text: [text] }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data: CloudflareEmbeddingResponse = await response.json();

    if (
      !data.success ||
      !data.result ||
      !data.result.data ||
      data.result.data.length === 0
    ) {
      console.error("Invalid response structure:", data);
      return undefined;
    }

    return data.result.data[0];
  } catch (error) {
    console.error("Error creating embeddings:", error);
    return undefined;
  }
}

export async function executeD1(query: string) {
  const { results } = await db.prepare(query).all();

  return results;
}

// export async function saveChat(chat: any) {
//   const { role, content } = chat;
//   const query = `INSERT INTO chats (role, content) VALUES (?, ?)`;
//   await db.prepare(query).bind(role, content).run();
// }
export interface Chat extends Record<string, any> {
  id: string;
  title: string;
  createdAt?: Date;
  userId?: string;
  path: string;
  messages: Message[];
  sharePath?: string;
}

export async function saveChat(chat: Chat) {
  const { id, title, path, userId } = chat;

  // Get the user message and the last assistant message from the messages array
  const userMessage = chat.messages.find((message) => message.role === "user");
  const lastAssistantMessage = chat.messages[chat.messages.length - 1];

  // Create a new array with the user message and the last assistant message
  const finalMessages = [userMessage, lastAssistantMessage];

  const serializedMessages = JSON.stringify(finalMessages);

  const insertQuery = `
    INSERT INTO chats (id, title, path, messages, userId)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      path = excluded.path,
      messages = excluded.messages,
      userId = excluded.userId
  `;

  await db
    .prepare(insertQuery)
    .bind(id, title, path, serializedMessages, userId)
    .run();
}
export async function getChat(id: string): Promise<Chat | null> {
  const query = `SELECT * FROM chats WHERE id = ?`;
  const { results } = await db.prepare(query).bind(id).all();

  if (results.length > 0) {
    const { id, title, createdAt, userId, path, messages, sharePath } =
      results[0] as Record<string, unknown>;

    if (typeof messages === "string") {
      const deserializedMessages: Message[] = JSON.parse(messages);
      return {
        id: id as string,
        title: title as string,
        createdAt: new Date(createdAt as string),
        userId: userId as string,
        path: path as string,
        messages: deserializedMessages,
        sharePath: sharePath as string,
      };
    }
  }

  return null;
}
