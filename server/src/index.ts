import "dotenv/config";
import cors from "cors";
import express from "express";
import { categories, schema } from "./domain/questions.js";
import { dashboardMetrics } from "./db.js";
import { assessmentsRouter } from "./routes/assessments.js";
import { openAiConfigured } from "./services/advice.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.use(cors({ origin: process.env.CORS_ORIGIN ?? true }));
app.use(express.json({ limit: "64kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, adviceEngine: openAiConfigured ? "openai" : "built-in" });
});

app.get("/api/schema", (_req, res) => {
  res.json(schema);
});

app.get("/api/dashboard", (_req, res) => {
  res.json({ ...dashboardMetrics(), bands: schema.bands, categories });
});

app.use("/api/assessments", assessmentsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "No route here." });
});

app.listen(PORT, () => {
  console.log(`Digital Families Programme API on http://localhost:${PORT}`);
  console.log(
    `Advice: ${openAiConfigured ? "OpenAI" : "built-in (set OPENAI_API_KEY to use OpenAI)"}`,
  );
});
