import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Assessment } from "./domain/types.js";

const DB_PATH = resolve(process.env.DATABASE_PATH ?? "./data/dfp.sqlite");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS assessments (
    id                TEXT PRIMARY KEY,
    created_at        TEXT NOT NULL,
    household_size    INTEGER NOT NULL,
    total_kg          REAL NOT NULL,
    per_person_kg     REAL NOT NULL,
    band              TEXT NOT NULL,
    health            REAL NOT NULL,
    answers_json      TEXT NOT NULL,
    categories_json   TEXT NOT NULL,
    advice_json       TEXT NOT NULL,
    advice_source     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_assessments_created ON assessments (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_assessments_band    ON assessments (band);

  /* One row per category per assessment. Denormalised on purpose: it makes the
     dashboard's "average by area" query a single GROUP BY instead of parsing
     JSON for every row. */
  CREATE TABLE IF NOT EXISTS category_totals (
    assessment_id TEXT NOT NULL REFERENCES assessments (id) ON DELETE CASCADE,
    category_id   TEXT NOT NULL,
    kg            REAL NOT NULL,
    PRIMARY KEY (assessment_id, category_id)
  );
`);

const insertAssessment = db.prepare(`
  INSERT INTO assessments (
    id, created_at, household_size,
    total_kg, per_person_kg, band, health, answers_json, categories_json,
    advice_json, advice_source
  ) VALUES (
    @id, @created_at, @household_size,
    @total_kg, @per_person_kg, @band, @health, @answers_json, @categories_json,
    @advice_json, @advice_source
  )
`);

const insertCategoryTotal = db.prepare(`
  INSERT INTO category_totals (assessment_id, category_id, kg)
  VALUES (?, ?, ?)
`);

export const saveAssessment = db.transaction((assessment: Assessment) => {
  insertAssessment.run({
    id: assessment.id,
    created_at: assessment.createdAt,
    household_size: assessment.household.size,
    total_kg: assessment.totalKg,
    per_person_kg: assessment.perPersonKg,
    band: assessment.band.letter,
    health: assessment.health,
    answers_json: JSON.stringify(assessment.answers),
    categories_json: JSON.stringify(assessment.categories),
    advice_json: JSON.stringify(assessment.advice),
    advice_source: assessment.advice.source,
  });

  for (const category of assessment.categories) {
    insertCategoryTotal.run(assessment.id, category.categoryId, category.kg);
  }
});

interface AssessmentRow {
  id: string;
  created_at: string;
  household_size: number;
  total_kg: number;
  per_person_kg: number;
  band: string;
  health: number;
  answers_json: string;
  categories_json: string;
  advice_json: string;
}

function hydrate(row: AssessmentRow, bandLookup: (letter: string) => Assessment["band"]): Assessment {
  return {
    id: row.id,
    createdAt: row.created_at,
    household: { size: row.household_size },
    totalKg: row.total_kg,
    perPersonKg: row.per_person_kg,
    band: bandLookup(row.band),
    health: row.health,
    answers: JSON.parse(row.answers_json),
    categories: JSON.parse(row.categories_json),
    advice: JSON.parse(row.advice_json),
  };
}

export function getAssessment(
  id: string,
  bandLookup: (letter: string) => Assessment["band"],
): Assessment | null {
  const row = db.prepare(`SELECT * FROM assessments WHERE id = ?`).get(id) as
    | AssessmentRow
    | undefined;
  return row ? hydrate(row, bandLookup) : null;
}

export function listAssessments(
  limit: number,
  bandLookup: (letter: string) => Assessment["band"],
): Assessment[] {
  const rows = db
    .prepare(`SELECT * FROM assessments ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as AssessmentRow[];
  return rows.map((row) => hydrate(row, bandLookup));
}

export interface DashboardMetrics {
  totalAssessments: number;
  averagePerPersonKg: number;
  medianPerPersonKg: number;
  averageHealth: number;
  averageHouseholdSize: number;
  peopleReached: number;
  bandCounts: { band: string; count: number }[];
  categoryAverages: { categoryId: string; averageKg: number }[];
  daily: { date: string; count: number; averagePerPersonKg: number }[];
  adviceSources: { source: string; count: number }[];
}

export function dashboardMetrics(): DashboardMetrics {
  const summary = db
    .prepare(
      `SELECT COUNT(*)              AS total,
              AVG(per_person_kg)    AS avg_pp,
              AVG(health)           AS avg_health,
              AVG(household_size)   AS avg_size,
              SUM(household_size)   AS people
       FROM assessments`,
    )
    .get() as {
    total: number;
    avg_pp: number | null;
    avg_health: number | null;
    avg_size: number | null;
    people: number | null;
  };

  const median = db
    .prepare(
      `SELECT per_person_kg AS value
       FROM assessments
       ORDER BY per_person_kg
       LIMIT 1 OFFSET (SELECT COUNT(*) FROM assessments) / 2`,
    )
    .get() as { value: number } | undefined;

  const bandCounts = db
    .prepare(`SELECT band, COUNT(*) AS count FROM assessments GROUP BY band ORDER BY band`)
    .all() as { band: string; count: number }[];

  const categoryAverages = db
    .prepare(
      `SELECT category_id AS categoryId, AVG(kg) AS averageKg
       FROM category_totals
       GROUP BY category_id
       ORDER BY averageKg DESC`,
    )
    .all() as { categoryId: string; averageKg: number }[];

  const daily = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS count,
              AVG(per_person_kg) AS averagePerPersonKg
       FROM assessments
       GROUP BY date
       ORDER BY date DESC
       LIMIT 30`,
    )
    .all() as { date: string; count: number; averagePerPersonKg: number }[];

  const adviceSources = db
    .prepare(`SELECT advice_source AS source, COUNT(*) AS count FROM assessments GROUP BY source`)
    .all() as { source: string; count: number }[];

  return {
    totalAssessments: summary.total,
    averagePerPersonKg: Math.round(summary.avg_pp ?? 0),
    averageHealth: Number((summary.avg_health ?? 0).toFixed(3)),
    medianPerPersonKg: Math.round(median?.value ?? 0),
    averageHouseholdSize: Number((summary.avg_size ?? 0).toFixed(1)),
    peopleReached: summary.people ?? 0,
    bandCounts,
    categoryAverages: categoryAverages.map((c) => ({
      categoryId: c.categoryId,
      averageKg: Math.round(c.averageKg),
    })),
    daily: daily
      .reverse()
      .map((d) => ({ ...d, averagePerPersonKg: Math.round(d.averagePerPersonKg) })),
    adviceSources,
  };
}
