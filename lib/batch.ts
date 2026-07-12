import { blob } from "https://esm.town/v/std/blob/main.ts";
import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

const API_BASE = "https://api.openai.com/v1";
const TERMINAL = new Set([
  "completed",
  "failed",
  "expired",
  "cancelled",
  "failed_local",
]);

export type Job = {
  id: string;
  name: string;
  endpoint: string;
  state: string;
  openai_batch_id: string | null;
  input_file_id: string | null;
  output_file_id: string | null;
  error_file_id: string | null;
  request_total: number;
  request_completed: number;
  request_failed: number;
  input_bytes: number;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

class OpenAIError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function ensureSchema() {
  await sqlite.batch([
    `CREATE TABLE IF NOT EXISTS batch_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      state TEXT NOT NULL,
      openai_batch_id TEXT,
      input_file_id TEXT,
      output_file_id TEXT,
      error_file_id TEXT,
      request_total INTEGER NOT NULL DEFAULT 0,
      request_completed INTEGER NOT NULL DEFAULT 0,
      request_failed INTEGER NOT NULL DEFAULT 0,
      input_bytes INTEGER NOT NULL,
      blob_key TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS batch_jobs_state_idx
      ON batch_jobs(state, updated_at)`,
    `CREATE TABLE IF NOT EXISTS worker_locks (
      name TEXT PRIMARY KEY,
      locked_until INTEGER NOT NULL
    )`,
  ]);
}

function apiKey() {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not configured");
  return key;
}

async function openai(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey()}`);
  if (
    !(init.body instanceof FormData) &&
    init.body &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new OpenAIError(
      response.status,
      `OpenAI ${response.status}: ${text.slice(0, 1000)}`,
    );
  }
  return response;
}

function validateJsonl(jsonl: string, endpoint: string) {
  const bytes = new TextEncoder().encode(jsonl).byteLength;
  const maxBytes = Number(
    Deno.env.get("MAX_QUEUED_FILE_BYTES") ?? 8_000_000,
  );
  if (!jsonl.trim()) throw new Error("JSONL input is empty");
  if (bytes > maxBytes) {
    throw new Error(
      `Input exceeds this val's ${maxBytes.toLocaleString()} byte queue limit`,
    );
  }

  const ids = new Set<string>();
  let requests = 0;
  let model: string | undefined;
  for (const [index, line] of jsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let item: Record<string, any>;
    try {
      item = JSON.parse(line);
    } catch {
      throw new Error(`Line ${index + 1} is not valid JSON`);
    }
    if (item.method !== "POST") {
      throw new Error(`Line ${index + 1}: method must be POST`);
    }
    if (item.url !== endpoint) {
      throw new Error(`Line ${index + 1}: url must equal ${endpoint}`);
    }
    if (typeof item.custom_id !== "string" || !item.custom_id) {
      throw new Error(`Line ${index + 1}: custom_id is required`);
    }
    if (ids.has(item.custom_id)) {
      throw new Error(
        `Line ${index + 1}: duplicate custom_id ${item.custom_id}`,
      );
    }
    ids.add(item.custom_id);
    const itemModel = item.body?.model;
    if (typeof itemModel === "string") {
      model ??= itemModel;
      if (model !== itemModel) {
        throw new Error(
          "All requests in a batch file must use the same model",
        );
      }
    }
    requests++;
  }
  if (!requests) throw new Error("JSONL contains no requests");
  if (requests > 50_000) {
    throw new Error("OpenAI allows at most 50,000 requests per batch");
  }
  return { bytes, requests };
}

export async function queueJob(
  name: string,
  endpoint: string,
  jsonl: string,
) {
  await ensureSchema();
  if (!endpoint.startsWith("/v1/")) {
    throw new Error("Endpoint must start with /v1/");
  }
  const { bytes, requests } = validateJsonl(jsonl, endpoint);
  const id = crypto.randomUUID();
  const blobKey = `batch-input:${id}`;
  const now = Date.now();
  await blob.set(blobKey, jsonl);
  try {
    await sqlite.execute({
      sql: `INSERT INTO batch_jobs
        (id, name, endpoint, state, request_total, input_bytes, blob_key,
         created_at, updated_at)
        VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      args: [
        id,
        name.trim() || `Batch ${new Date(now).toLocaleString()}`,
        endpoint,
        requests,
        bytes,
        blobKey,
        now,
        now,
      ],
    });
  } catch (error) {
    await blob.delete(blobKey);
    throw error;
  }
  return id;
}

export async function listJobs(): Promise<Job[]> {
  await ensureSchema();
  const result = await sqlite.execute(
    `SELECT id, name, endpoint, state, openai_batch_id, input_file_id,
      output_file_id, error_file_id, request_total, request_completed,
      request_failed, input_bytes, attempts, last_error, created_at, updated_at
      FROM batch_jobs ORDER BY created_at DESC LIMIT 100`,
  );
  return result.rows as unknown as Job[];
}

export async function getJob(id: string) {
  await ensureSchema();
  const result = await sqlite.execute({
    sql: "SELECT * FROM batch_jobs WHERE id = ?",
    args: [id],
  });
  return result.rows[0] as Record<string, any> | undefined;
}

async function acquireLock() {
  const now = Date.now();
  const result = await sqlite.execute({
    sql: `INSERT INTO worker_locks(name, locked_until)
      VALUES ('batch-worker', ?)
      ON CONFLICT(name) DO UPDATE SET locked_until = excluded.locked_until
      WHERE worker_locks.locked_until < ?`,
    args: [now + 4 * 60_000, now],
  });
  return result.rowsAffected > 0;
}

async function updateFromBatch(id: string, batch: any) {
  await sqlite.execute({
    sql: `UPDATE batch_jobs SET state = ?, openai_batch_id = ?,
      input_file_id = ?, output_file_id = ?, error_file_id = ?,
      request_total = ?, request_completed = ?, request_failed = ?,
      last_error = ?, updated_at = ? WHERE id = ?`,
    args: [
      batch.status,
      batch.id,
      batch.input_file_id,
      batch.output_file_id ?? null,
      batch.error_file_id ?? null,
      batch.request_counts?.total ?? 0,
      batch.request_counts?.completed ?? 0,
      batch.request_counts?.failed ?? 0,
      batch.errors ? JSON.stringify(batch.errors).slice(0, 4000) : null,
      Date.now(),
      id,
    ],
  });
}

async function submitJob(job: Record<string, any>) {
  await sqlite.execute({
    sql: `UPDATE batch_jobs SET state = 'submitting',
      attempts = attempts + 1, updated_at = ? WHERE id = ?`,
    args: [Date.now(), job.id],
  });
  try {
    let inputFileId = job.input_file_id as string | null;
    if (!inputFileId) {
      const response = await blob.get(job.blob_key);
      const jsonl = await response.text();
      const form = new FormData();
      form.set("purpose", "batch");
      form.set(
        "file",
        new File([jsonl], `${job.id}.jsonl`, {
          type: "application/jsonl",
        }),
      );
      const uploaded = await openai("/files", {
        method: "POST",
        body: form,
      }).then((r) => r.json());
      inputFileId = uploaded.id;
      await sqlite.execute({
        sql: `UPDATE batch_jobs SET input_file_id = ?, updated_at = ?
          WHERE id = ?`,
        args: [inputFileId, Date.now(), job.id],
      });
    }
    const batch = await openai("/batches", {
      method: "POST",
      body: JSON.stringify({
        input_file_id: inputFileId,
        endpoint: job.endpoint,
        completion_window: "24h",
        metadata: {
          val_job_id: job.id,
          name: job.name.slice(0, 200),
        },
      }),
    }).then((r) => r.json());
    await updateFromBatch(job.id, batch);
    if (job.blob_key) await blob.delete(job.blob_key);
    await sqlite.execute({
      sql: "UPDATE batch_jobs SET blob_key = NULL WHERE id = ?",
      args: [job.id],
    });
  } catch (error) {
    const retryable = error instanceof OpenAIError &&
      (error.status === 429 || error.status >= 500);
    await sqlite.execute({
      sql: `UPDATE batch_jobs SET state = ?, last_error = ?, updated_at = ?
        WHERE id = ?`,
      args: [
        retryable ? "queued" : "failed_local",
        String(error).slice(0, 4000),
        Date.now(),
        job.id,
      ],
    });
  }
}

export async function refreshJob(id: string) {
  const job = await getJob(id);
  if (!job) throw new Error("Job not found");
  if (!job.openai_batch_id || TERMINAL.has(job.state)) return job;
  const batch = await openai(`/batches/${job.openai_batch_id}`).then((r) =>
    r.json()
  );
  await updateFromBatch(id, batch);
  return await getJob(id);
}

export async function runWorker() {
  await ensureSchema();
  if (!(await acquireLock())) return { skipped: "worker already running" };

  const stale = Date.now() - 20 * 60_000;
  await sqlite.execute({
    sql: `UPDATE batch_jobs SET state = 'queued',
      last_error = 'Recovered a stale submission', updated_at = ?
      WHERE state = 'submitting' AND updated_at < ?`,
    args: [Date.now(), stale],
  });

  const active = await sqlite.execute(
    `SELECT id FROM batch_jobs WHERE openai_batch_id IS NOT NULL
      AND state NOT IN ('completed', 'failed', 'expired', 'cancelled')
      ORDER BY updated_at ASC LIMIT 50`,
  );
  for (const row of active.rows) {
    try {
      await refreshJob(String(row.id));
    } catch (error) {
      await sqlite.execute({
        sql: `UPDATE batch_jobs SET last_error = ?, updated_at = ?
          WHERE id = ?`,
        args: [String(error).slice(0, 4000), Date.now(), row.id],
      });
    }
  }

  const limit = Math.max(
    1,
    Math.min(
      20,
      Number(Deno.env.get("MAX_BATCH_SUBMISSIONS_PER_RUN") ?? 3),
    ),
  );
  const queued = await sqlite.execute({
    sql: `SELECT * FROM batch_jobs WHERE state = 'queued'
      ORDER BY created_at ASC LIMIT ?`,
    args: [limit],
  });
  for (const job of queued.rows) {
    await submitJob(job as Record<string, any>);
  }
  await sqlite.execute({
    sql: `UPDATE worker_locks SET locked_until = 0
      WHERE name = 'batch-worker'`,
  });
  return {
    refreshed: active.rows.length,
    submitted: queued.rows.length,
  };
}

export async function cancelJob(id: string) {
  const job = await getJob(id);
  if (!job) throw new Error("Job not found");
  if (job.state === "queued") {
    if (job.blob_key) await blob.delete(job.blob_key);
    await sqlite.execute({
      sql: `UPDATE batch_jobs SET state = 'cancelled', blob_key = NULL,
        updated_at = ? WHERE id = ?`,
      args: [Date.now(), id],
    });
    return;
  }
  if (!job.openai_batch_id || TERMINAL.has(job.state)) {
    throw new Error("Job cannot be cancelled in its current state");
  }
  const batch = await openai(`/batches/${job.openai_batch_id}/cancel`, {
    method: "POST",
  }).then((r) => r.json());
  await updateFromBatch(id, batch);
}

export async function fileResponse(
  id: string,
  kind: "output" | "error",
) {
  const job = await getJob(id);
  if (!job) throw new Error("Job not found");
  const fileId = kind === "output" ? job.output_file_id : job.error_file_id;
  if (!fileId) throw new Error(`${kind} file is not available`);
  return await openai(`/files/${fileId}/content`);
}
