import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "./index.js";

const schema = readFileSync(
  fileURLToPath(new URL("./schema.sql", import.meta.url)),
  "utf8",
);

const sql = await pool.connect();
try {
  await sql.query(schema);
  console.log("schema applied");
} finally {
  sql.release();
  await pool.end();
}
