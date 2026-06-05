// embeddings.ts — Embedding provider adapter
// Supports: OpenAI, Google, Ollama, Mistral, LM Studio

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EmbeddingProviderConfig, ServerConfig } from './types.js';

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export function loadConfig(configPath?: string): ServerConfig {
  // Check for explicit path, then cwd config, then server-local config
  const candidates = [
    configPath,
    resolve(process.cwd(), 'repo-context.json'),
    resolve(process.cwd(), '.repo-context', 'config.json'),
    resolve(import.meta.dir, '..', 'config.json'),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      console.error(`[config] Loaded from ${path}`);
      return JSON.parse(raw) as ServerConfig;
    }
  }

  throw new Error(
    `Config not found. Create repo-context.json in project root, .repo-context/config.json, or config.json next to the server.`,
  );
}

// ---------------------------------------------------------------------------
// Known dimensions per model
// ---------------------------------------------------------------------------

const MODEL_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  'text-embedding-004': 768,
  'nomic-embed-text': 768,
  'nomic-embed-code': 3584,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
  'mistral-embed': 1024,
};

const PROVIDER_DEFAULT_DIMS: Record<string, number> = {
  openai: 1536,
  google: 768,
  ollama: 768,
  mistral: 1024,
  lmstudio: 768,
  tei: 3584,
};

export function getDimensions(config: EmbeddingProviderConfig): number {
  return MODEL_DIMENSIONS[config.model] ?? PROVIDER_DEFAULT_DIMS[config.type] ?? 768;
}

// ---------------------------------------------------------------------------
// Provider implementations — plain fetch, no SDK
// ---------------------------------------------------------------------------

async function embedOpenAI(texts: string[], config: EmbeddingProviderConfig): Promise<number[][]> {
  const baseUrl = config.baseUrl ?? 'https://api.openai.com';
  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey ?? ''}`,
    },
    body: JSON.stringify({ model: config.model, input: texts }),
  });
  if (!res.ok) throw new Error(`OpenAI embedding error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

async function embedGoogle(texts: string[], config: EmbeddingProviderConfig): Promise<number[][]> {
  const results = await Promise.all(
    texts.map(async (text) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:embedContent?key=${config.apiKey ?? ''}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text }] } }),
      });
      if (!res.ok) throw new Error(`Google embedding error ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { embedding: { values: number[] } };
      return data.embedding.values;
    }),
  );
  return results;
}

async function embedOllama(texts: string[], config: EmbeddingProviderConfig): Promise<number[][]> {
  const baseUrl = config.baseUrl ?? 'http://localhost:11434';
  const res = await fetch(`${baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, input: texts }),
  });
  if (!res.ok) throw new Error(`Ollama embedding error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings;
}

async function embedLmStudio(texts: string[], config: EmbeddingProviderConfig): Promise<number[][]> {
  let root = config.baseUrl ?? 'http://localhost:1234';
  root = root.replace(/\/v1\/?$/, '');
  const res = await fetch(`${root}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, input: texts }),
  });
  if (!res.ok) throw new Error(`LM Studio embedding error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

async function embedMistral(texts: string[], config: EmbeddingProviderConfig): Promise<number[][]> {
  const res = await fetch('https://api.mistral.ai/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey ?? ''}`,
    },
    body: JSON.stringify({ model: config.model, input: texts }),
  });
  if (!res.ok) throw new Error(`Mistral embedding error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

async function embedTei(texts: string[], config: EmbeddingProviderConfig): Promise<number[][]> {
  // HuggingFace Text Embeddings Inference (TEI) exposes an OpenAI-compatible
  // `/v1/embeddings` endpoint. nomic-embed-code is served this way.
  let root = config.baseUrl ?? 'http://localhost:8080';
  root = root.replace(/\/v1\/?$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const res = await fetch(`${root}/v1/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.model, input: texts }),
  });
  if (!res.ok) throw new Error(`TEI embedding error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const BATCH_SIZES: Record<string, number> = {
  ollama: 1,
  lmstudio: 10,
  openai: 50,
  google: 20,
  mistral: 50,
  tei: 32,
};

const MAX_TEXT_CHARS = 4000;

function truncateForEmbedding(text: string): string {
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
}

/**
 * Apply an asymmetric task prefix to a text based on the embedding model and
 * whether it is a search query or a document being indexed. Nomic models use
 * instruction prefixes to distinguish query vs document representations.
 */
function applyPrefix(
  text: string,
  config: EmbeddingProviderConfig,
  mode: 'query' | 'document',
): string {
  const model = config.model;
  // nomic-embed-code (and variants) — query gets an instruction, documents none.
  if (model.includes('nomic-embed-code')) {
    return mode === 'query'
      ? `Represent this query for searching relevant code: ${text}`
      : text;
  }
  // nomic-embed-text (and tagged variants like `nomic-embed-text:v1.5`).
  if (model === 'nomic-embed-text' || model.startsWith('nomic-embed-text:')) {
    return mode === 'query' ? `search_query: ${text}` : `search_document: ${text}`;
  }
  // Any other model: identity.
  return text;
}

const PROVIDERS: Record<
  string,
  (texts: string[], config: EmbeddingProviderConfig) => Promise<number[][]>
> = {
  openai: embedOpenAI,
  google: embedGoogle,
  ollama: embedOllama,
  lmstudio: embedLmStudio,
  mistral: embedMistral,
  tei: embedTei,
};

export async function embedBatch(
  texts: string[],
  config: EmbeddingProviderConfig,
  mode: 'query' | 'document' = 'document',
): Promise<number[][]> {
  const fn = PROVIDERS[config.type];
  if (!fn) throw new Error(`Unknown embedding provider: ${config.type}`);

  const batchSize = BATCH_SIZES[config.type] ?? 10;
  // Apply asymmetric task prefixes before truncation, once for the whole batch.
  const truncated = texts.map((t) => truncateForEmbedding(applyPrefix(t, config, mode)));

  const dims = getDimensions(config);
  const results: number[][] = [];
  for (let i = 0; i < truncated.length; i += batchSize) {
    const batch = truncated.slice(i, i + batchSize);
    try {
      const batchResults = await fn(batch, config);
      results.push(...batchResults);
    } catch (err) {
      console.error(`[embed] Batch failed at offset ${i}, retrying individually...`);
      for (const text of batch) {
        try {
          const shorter = text.slice(0, 2000);
          const [result] = await fn([shorter], config);
          results.push(result);
        } catch {
          console.error(`[embed] Skipping chunk (too long even after truncation)`);
          results.push(new Array(dims).fill(0));
        }
      }
    }
  }
  return results;
}

export async function embedSingle(
  text: string,
  config: EmbeddingProviderConfig,
  mode: 'query' | 'document' = 'query',
): Promise<number[]> {
  const [result] = await embedBatch([text], config, mode);
  return result;
}
