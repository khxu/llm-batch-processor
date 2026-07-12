# OpenAI Batch Console

A Val Town dashboard for queueing OpenAI Batch API JSONL files, monitoring batch
progress, cancelling jobs, and downloading output/error files.

- Val: https://www.val.town/x/khxu/openai-batch-dashboard
- Live dashboard: https://khxu--019f57879e56744ca7c10231b454a6bb.web.val.run

## Setup

1. Create an OpenAI API key at https://platform.openai.com/api-keys.
2. Add it to the val as `OPENAI_API_KEY`.
3. Log in with Val Town at the HTTP endpoint. Access is restricted to `khxu`.
4. Paste a valid OpenAI Batch JSONL file and queue it.

Add the OpenAI key here:

https://www.val.town/x/khxu/openai-batch-dashboard/environment-variables?key=OPENAI_API_KEY

Optional val environment variables:

- `MAX_BATCH_SUBMISSIONS_PER_RUN` - queued batches submitted per worker run
  (default `3`, maximum `20`).
- `MAX_QUEUED_FILE_BYTES` - maximum transient JSONL size accepted by the val
  (default `8000000`).

## GitHub and Val Town sync

GitHub is the source of truth. `.github/workflows/deploy.yml` deploys pushes to
`main` with the Val Town `vt` CLI. `.github/workflows/pull.yml` periodically
captures edits made in the Val Town editor.

Create a Val Town API key with val read/write scope at:

https://www.val.town/settings/api

Add it to this repository as the `VAL_TOWN_API_KEY` Actions secret:

https://github.com/khxu/llm-batch-processor/settings/secrets/actions/new

The workflows intentionally fail with a clear message until that secret is
configured.

## Storage and rate limits

SQLite stores only job metadata. Blob storage holds input JSONL only while a job
is queued and deletes it after OpenAI accepts the batch. Output and error files
are streamed directly from OpenAI, so they do not consume Val Town blob storage.

Val Town blob storage is account-wide: 10 MB on Free and 1 GB on Pro. The
default 8 MB input cap is intentionally conservative. Separate object storage is
unnecessary for ordinary small/medium batches with a short queue. Use S3/R2 if
you need multiple large queued inputs or retained archives.

The worker runs every 15 minutes. It polls active batches and submits a bounded
number of queued jobs. OpenAI Batch API limits are separate from synchronous API
limits; account-specific enqueued-token limits still apply.

## Security

The UI and APIs use Val Town OAuth and reject users other than `khxu`. The
OpenAI key remains server-side in Val Town environment variables.
