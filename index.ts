import { parseVal, serveFile } from "https://esm.town/v/std/utils/index.ts";
import {
  getOAuthUserData,
  oauthMiddleware,
} from "https://esm.town/v/std/oauth/middleware.ts";
import { Hono } from "npm:hono";
import {
  cancelJob,
  fileResponse,
  listJobs,
  queueJob,
  refreshJob,
} from "./lib/batch.ts";

const app = new Hono();
const OWNER = "khxu";

async function requireOwner(request: Request) {
  const session = await getOAuthUserData(request);
  if (!session?.user) return { error: "login" as const };
  if (session.user.username !== OWNER) return { error: "forbidden" as const };
  return { session };
}

app.get("/", async (c) => {
  const auth = await requireOwner(c.req.raw);
  if ("error" in auth) {
    return auth.error === "login"
      ? c.redirect("/auth/login")
      : c.text("Forbidden", 403);
  }
  return serveFile("/frontend/index.html");
});

app.get("/frontend/**/*", (c) => serveFile(c.req.path));
app.get("/source", (c) => c.redirect(parseVal().links.self.val));

app.use("/api/*", async (c, next) => {
  const auth = await requireOwner(c.req.raw);
  if ("error" in auth) {
    return c.json(
      {
        error: auth.error === "login" ? "Authentication required" : "Forbidden",
      },
      auth.error === "login" ? 401 : 403,
    );
  }
  await next();
});

app.get("/api/session", async (c) => {
  const session = await getOAuthUserData(c.req.raw);
  return c.json({
    username: session?.user.username,
    storage: {
      free: "10 MB",
      pro: "1 GB",
      strategy:
        "Inputs are deleted after submission; results stream from OpenAI.",
    },
  });
});

app.get("/api/jobs", async (c) => c.json({ jobs: await listJobs() }));

app.post("/api/jobs", async (c) => {
  const body = await c.req.json<{
    name?: string;
    endpoint?: string;
    jsonl?: string;
  }>();
  if (
    typeof body.endpoint !== "string" ||
    typeof body.jsonl !== "string"
  ) {
    return c.json({ error: "endpoint and jsonl are required" }, 400);
  }
  try {
    const id = await queueJob(body.name ?? "", body.endpoint, body.jsonl);
    return c.json({ id }, 201);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      400,
    );
  }
});

app.post("/api/jobs/:id/refresh", async (c) => {
  try {
    return c.json({ job: await refreshJob(c.req.param("id")) });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      400,
    );
  }
});

app.post("/api/jobs/:id/cancel", async (c) => {
  try {
    await cancelJob(c.req.param("id"));
    return c.json({ ok: true });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      400,
    );
  }
});

app.get("/api/jobs/:id/:kind", async (c) => {
  const kind = c.req.param("kind");
  if (kind !== "output" && kind !== "error") {
    return c.json({ error: "Unknown file kind" }, 404);
  }
  try {
    const response = await fileResponse(c.req.param("id"), kind);
    return new Response(response.body, {
      headers: {
        "Content-Type": "application/jsonl",
        "Content-Disposition": `attachment; filename="batch-${
          c.req.param("id")
        }-${kind}.jsonl"`,
      },
    });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      400,
    );
  }
});

app.onError((err) => Promise.reject(err));
export default oauthMiddleware(app.fetch);
