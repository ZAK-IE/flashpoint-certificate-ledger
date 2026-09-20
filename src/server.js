import "./env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { api } from "./routes/api.js";
import { migrate } from "./migrate.js";
import { pool } from "./db.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = express();

app.set("trust proxy", 1);
app.use(cors());                       // reads are public, so any origin may verify
app.use(express.json({ limit: "64kb" }));

app.use("/api", api);
app.use(express.static(path.join(root, "public"), { extensions: ["html"] }));
app.get("*", (_req, res) => res.sendFile(path.join(root, "public", "index.html")));

const port = process.env.PORT || 3000;

async function start() {
  if (process.env.RUN_MIGRATIONS !== "false") {
    const result = await migrate();
    console.log("Schema ready:", result);
  }
  app.listen(port, () => console.log(`Certificate ledger listening on port ${port}`));
}

start().catch(err => {
  console.error("Startup failed:", err);
  pool.end().finally(() => process.exit(1));
});
