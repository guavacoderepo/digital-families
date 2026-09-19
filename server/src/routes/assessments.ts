import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { calculate } from "../domain/calculator.js";
import { bands, questionsById } from "../domain/questions.js";
import type { Assessment, Band } from "../domain/types.js";
import { getAssessment, listAssessments, saveAssessment } from "../db.js";
import { generateAdvice } from "../services/advice.js";

export const assessmentsRouter = Router();

const bandLookup = (letter: string): Band =>
  bands.find((b) => b.letter === letter) ?? bands[bands.length - 1]!;

const bodySchema = z.object({
  household: z.object({ size: z.number().int().min(1).max(20) }),
  answers: z.record(z.number().finite().nonnegative()),
});

assessmentsRouter.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Those answers could not be read. Please try again." });
  }

  const { household, answers } = parsed.data;

  // Drop anything that is not a question we know about, so an out-of-date page
  // cannot write junk into the store.
  const cleanAnswers = Object.fromEntries(
    Object.entries(answers).filter(([id]) => questionsById.has(id)),
  );

  const result = calculate(cleanAnswers, household);
  const advice = await generateAdvice(result, household, cleanAnswers);

  const assessment: Assessment = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    household,
    answers: cleanAnswers,
    advice,
    ...result,
  };

  try {
    saveAssessment(assessment);
  } catch (error) {
    console.error("[assessments] failed to save:", error);
    return res.status(500).json({ error: "Your answers could not be saved. Please try again." });
  }

  res.status(201).json(assessment);
});

assessmentsRouter.get("/", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  res.json(listAssessments(limit, bandLookup));
});

assessmentsRouter.get("/:id", (req, res) => {
  const assessment = getAssessment(req.params.id, bandLookup);
  if (!assessment) return res.status(404).json({ error: "No result with that reference." });
  res.json(assessment);
});
