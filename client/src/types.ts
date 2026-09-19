/**
 * The shape of everything the API returns. Kept in step with
 * `server/src/domain/types.ts` by hand — the server serves the questionnaire
 * itself from `GET /api/schema`, so adding a question needs no change here.
 */

export interface Question {
  id: string;
  categoryId: string;
  label: string;
  unit: string;
  step: number;
  max: number;
  kgPerUnit: number;
}

export interface Category {
  id: string;
  name: string;
  blurb: string;
  baselinePerPerson?: number;
  baselineLabel?: string;
}

export interface Band {
  letter: string;
  label: string;
  minTonnes: number;
  maxTonnes: number;
  color: string;
}

export interface Schema {
  categories: Category[];
  questions: Question[];
  bands: Band[];
  methodologyNote: string;
}

export interface CategoryResult {
  categoryId: string;
  name: string;
  kg: number;
  share: number;
  baselineKg: number;
}

export interface AdviceAction {
  text: string;
  savingKg: number;
  savingPounds?: number;
}

export interface Advice {
  summary: string;
  comparison: string;
  actions: AdviceAction[];
  source: "openai" | "built-in";
  model?: string;
}

export interface Assessment {
  id: string;
  createdAt: string;
  household: { size: number };
  answers: Record<string, number>;
  totalKg: number;
  perPersonKg: number;
  band: Band;
  health: number;
  categories: CategoryResult[];
  advice: Advice;
}

export interface DashboardData {
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
  bands: Band[];
  categories: Category[];
}
