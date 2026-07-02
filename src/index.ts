import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { routes } from "./routes.js";

const app = Fastify({
  logger: true,
  // behind a PaaS proxy the client IP arrives in x-forwarded-for; without
  // this the rate limiter would key every request on the proxy's IP
  trustProxy: process.env.TRUST_PROXY === "true",
});

// per-IP, in-memory (single instance). global: false — limits are set
// per-route in routes.ts so /healthz stays exempt for platform health checks.
await app.register(rateLimit, { global: false });

app.get("/healthz", async () => ({ ok: true }));
await app.register(routes);

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
