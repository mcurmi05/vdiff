import Fastify from "fastify";
import { routes } from "./routes.js";

const app = Fastify({ logger: true });

app.get("/healthz", async () => ({ ok: true }));
await app.register(routes);

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
