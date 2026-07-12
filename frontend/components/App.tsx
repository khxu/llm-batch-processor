/** @jsxImportSource https://esm.sh/react@18.2.0 */
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "https://esm.sh/react@18.2.0";

type Job = {
  id: string;
  name: string;
  endpoint: string;
  state: string;
  openai_batch_id: string | null;
  output_file_id: string | null;
  error_file_id: string | null;
  request_total: number;
  request_completed: number;
  request_failed: number;
  input_bytes: number;
  last_error: string | null;
  created_at: number;
};

const sample =
  `{"custom_id":"request-1","method":"POST","url":"/v1/responses","body":{"model":"gpt-5-mini","input":"Write a one-line greeting."}}`;
const terminal = new Set([
  "completed",
  "failed",
  "expired",
  "cancelled",
  "failed_local",
]);

async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? `Request failed (${response.status})`);
  }
  return data;
}

function badge(state: string) {
  if (state === "completed") {
    return "bg-emerald-100 text-emerald-800";
  }
  if (["failed", "expired", "failed_local"].includes(state)) {
    return "bg-red-100 text-red-800";
  }
  if (["queued", "submitting"].includes(state)) {
    return "bg-amber-100 text-amber-800";
  }
  return "bg-blue-100 text-blue-800";
}

export function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("/v1/responses");
  const [jsonl, setJsonl] = useState(sample);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const activeCount = useMemo(
    () => jobs.filter((job) => !terminal.has(job.state)).length,
    [jobs],
  );

  async function load() {
    try {
      setJobs((await api("/api/jobs")).jobs);
    } catch (error) {
      setMessage(String(error));
    }
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, []);

  async function loadFiles(files: File[]) {
    if (files.length === 0) return;

    setMessage("");
    try {
      const contents = await Promise.all(files.map((file) => file.text()));
      const combined = contents.reduce((result, content) => {
        if (result && !result.endsWith("\n") && !content.startsWith("\n")) {
          return `${result}\n${content}`;
        }
        return result + content;
      }, "");
      setJsonl(combined);
      setFileNames(files.map((file) => file.name));
      if (!name && files.length === 1) {
        setName(files[0].name.replace(/\.(jsonl|ndjson)$/i, ""));
      }
    } catch (error) {
      setMessage(
        `Could not read the selected files: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    void loadFiles(Array.from(event.currentTarget.files ?? []));
    event.currentTarget.value = "";
  }

  function dropFiles(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void loadFiles(Array.from(event.dataTransfer.files));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await api("/api/jobs", {
        method: "POST",
        body: JSON.stringify({ name, endpoint, jsonl }),
      });
      setName("");
      setMessage(
        "Queued. The worker submits up to three batches every 15 minutes.",
      );
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function action(id: string, verb: "refresh" | "cancel") {
    setMessage("");
    try {
      await api(`/api/jobs/${id}/${verb}`, { method: "POST" });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-950/90">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <div>
            <h1 className="text-xl font-semibold">
              OpenAI Batch Console
            </h1>
            <p className="text-sm text-slate-400">
              Queue, monitor, and download JSONL results.
            </p>
          </div>
          <form method="POST" action="/auth/logout">
            <button className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800">
              Log out
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-5 py-8 lg:grid-cols-[380px_1fr]">
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl">
          <h2 className="text-lg font-semibold">New batch</h2>
          <form className="mt-4 space-y-4" onSubmit={submit}>
            <label className="block text-sm text-slate-300">
              Name
              <input
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder="Nightly classification"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-blue-500"
              />
            </label>
            <label className="block text-sm text-slate-300">
              Endpoint
              <input
                value={endpoint}
                onChange={(e) => setEndpoint(e.currentTarget.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm outline-none focus:border-blue-500"
              />
            </label>
            <div className="text-sm text-slate-300">
              <span>Batch JSONL</span>
              <div
                onDragEnter={(event) => {
                  event.preventDefault();
                  dragDepth.current += 1;
                  setDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => {
                  dragDepth.current = Math.max(0, dragDepth.current - 1);
                  if (dragDepth.current === 0) {
                    setDragging(false);
                  }
                }}
                onDrop={dropFiles}
                className={`mt-1 rounded-lg border-2 border-dashed p-4 text-center transition ${
                  dragging
                    ? "border-blue-400 bg-blue-950/40"
                    : "border-slate-700 bg-slate-950"
                }`}
              >
                <input
                  ref={fileInput}
                  type="file"
                  accept=".jsonl,.ndjson,application/jsonl,application/x-ndjson"
                  multiple
                  onChange={selectFiles}
                  className="hidden"
                />
                <p className="text-sm text-slate-300">
                  Drop one or more JSONL files here
                </p>
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="mt-2 rounded-lg border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
                >
                  Choose files
                </button>
                <p className="mt-2 text-xs text-slate-500">
                  Multiple files are combined in selection order.
                </p>
              </div>
              {fileNames.length > 0 && (
                <p className="mt-2 break-words text-xs text-slate-400">
                  Loaded {fileNames.length} file{fileNames.length === 1 ? "" : "s"}:
                  {" "}
                  {fileNames.join(", ")}
                </p>
              )}
              <textarea
                value={jsonl}
                onChange={(e) => {
                  setJsonl(e.currentTarget.value);
                  setFileNames([]);
                }}
                rows={13}
                spellCheck={false}
                aria-label="Batch JSONL content"
                className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-blue-500"
              />
            </div>
            <button
              disabled={busy}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium hover:bg-blue-500 disabled:opacity-50"
            >
              {busy ? "Queuing..." : "Queue batch"}
            </button>
          </form>
          <div className="mt-4 rounded-lg bg-slate-950 p-3 text-xs leading-5 text-slate-400">
            OpenAI allows up to 50,000 requests and 200 MB per batch. This val
            defaults to an 8 MB transient queue cap to protect Val Town storage.
          </div>
        </section>

        <section>
          <div className="mb-4 flex items-end justify-between">
            <div>
              <h2 className="text-lg font-semibold">Jobs</h2>
              <p className="text-sm text-slate-400">
                {activeCount} active - auto-refreshes every 30 seconds
              </p>
            </div>
            <button
              onClick={load}
              className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800"
            >
              Reload
            </button>
          </div>
          {message && (
            <div className="mb-4 rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm">
              {message}
            </div>
          )}
          <div className="space-y-3">
            {jobs.length === 0 && (
              <div className="rounded-2xl border border-dashed border-slate-700 p-10 text-center text-slate-400">
                No batch jobs yet.
              </div>
            )}
            {jobs.map((job) => (
              <article
                key={job.id}
                className="rounded-2xl border border-slate-800 bg-slate-900 p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-medium">{job.name}</h3>
                    <p className="mt-1 font-mono text-xs text-slate-500">
                      {job.openai_batch_id ?? job.id}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                      badge(job.state)
                    }`}
                  >
                    {job.state}
                  </span>
                </div>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full bg-blue-500"
                    style={{
                      width: `${
                        job.request_total
                          ? Math.round(
                            ((job.request_completed + job.request_failed) /
                              job.request_total) * 100,
                          )
                          : 0
                      }%`,
                    }}
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
                  <span>
                    {job.request_completed}/{job.request_total} completed
                  </span>
                  <span>{job.request_failed} failed</span>
                  <span>{(job.input_bytes / 1024).toFixed(1)} KB</span>
                  <span>{job.endpoint}</span>
                </div>
                {job.last_error && (
                  <pre className="mt-3 overflow-auto whitespace-pre-wrap rounded-lg bg-red-950/40 p-3 text-xs text-red-200">
                    {job.last_error}
                  </pre>
                )}
                <div className="mt-4 flex flex-wrap gap-2 text-sm">
                  {!terminal.has(job.state) && job.openai_batch_id && (
                    <button
                      onClick={() => action(job.id, "refresh")}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 hover:bg-slate-800"
                    >
                      Refresh status
                    </button>
                  )}
                  {!terminal.has(job.state) && (
                    <button
                      onClick={() => action(job.id, "cancel")}
                      className="rounded-lg border border-red-900 px-3 py-1.5 text-red-300 hover:bg-red-950"
                    >
                      Cancel
                    </button>
                  )}
                  {job.output_file_id && (
                    <a
                      href={`/api/jobs/${job.id}/output`}
                      className="rounded-lg bg-emerald-700 px-3 py-1.5 hover:bg-emerald-600"
                    >
                      Download output
                    </a>
                  )}
                  {job.error_file_id && (
                    <a
                      href={`/api/jobs/${job.id}/error`}
                      className="rounded-lg border border-amber-800 px-3 py-1.5 text-amber-300 hover:bg-amber-950"
                    >
                      Download errors
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
          <p className="mt-6 text-center text-xs text-slate-500">
            <a
              href="/source"
              className="underline hover:text-slate-300"
            >
              View source and remix
            </a>
          </p>
        </section>
      </main>
    </div>
  );
}
