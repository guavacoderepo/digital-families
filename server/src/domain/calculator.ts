import { bands, categories, questions } from "./questions.js";
import type { Band, CategoryResult, FootprintResult, Household } from "./types.js";

function round(n: number): number {
  return Math.round(n);
}

export function bandFor(tonnesPerPerson: number): Band {
  return (
    bands.find((b) => tonnesPerPerson >= b.minTonnes && tonnesPerPerson < b.maxTonnes) ??
    bands[bands.length - 1]!
  );
}

/**
 * How healthy the grass is drawn, from 0 (bare earth) to 1 (thriving).
 *
 * A curve rather than a straight line, pinned so that the UK average of about
 * 6.5 tonnes a head lands squarely in the middle. A straight line would leave
 * almost everybody in the same washed-out state and the picture would stop
 * telling anyone anything.
 */
export function healthFor(tonnesPerPerson: number): number {
  if (tonnesPerPerson <= 0) return 1;
  const health = 1 / (1 + Math.pow(tonnesPerPerson / 6.5, 1.6));
  return Math.min(1, Math.max(0, health));
}

export function calculate(
  answers: Record<string, number>,
  household: Household,
): FootprintResult {
  const size = Math.max(1, Math.round(household.size || 1));

  const perQuestion = new Map<string, number>();
  for (const question of questions) {
    const raw = Number(answers[question.id] ?? 0);
    const value = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), question.max) : 0;
    perQuestion.set(question.id, value * question.kgPerUnit);
  }

  const categoryResults: CategoryResult[] = categories.map((category) => {
    const answered = questions
      .filter((q) => q.categoryId === category.id)
      .reduce((sum, q) => sum + (perQuestion.get(q.id) ?? 0), 0);

    const baseline = (category.baselinePerPerson ?? 0) * size;

    return {
      categoryId: category.id,
      name: category.name,
      kg: round(answered + baseline),
      baselineKg: round(baseline),
      share: 0,
    };
  });

  const totalKg = categoryResults.reduce((sum, c) => sum + c.kg, 0);
  for (const category of categoryResults) {
    category.share = totalKg > 0 ? category.kg / totalKg : 0;
  }

  const perPersonKg = totalKg / size;
  const tonnes = perPersonKg / 1000;

  return {
    totalKg: round(totalKg),
    perPersonKg: round(perPersonKg),
    band: bandFor(tonnes),
    health: Number(healthFor(tonnes).toFixed(3)),
    categories: categoryResults,
  };
}
