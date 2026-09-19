/**
 * Domain types for the Digital Families Programme footprint model.
 *
 * The questionnaire is data, not code: the client fetches it from
 * `GET /api/schema` and renders whatever it is given. Adding a question means
 * editing `questions.ts` only.
 *
 * Every question is a count that starts at zero. There are no dropdowns and no
 * questions that adjust other questions — the people using this are working
 * through it once, often on a tablet, sometimes with a volunteer sitting
 * beside them. Anything cleverer than "how many, in a week?" costs more in
 * confusion than it buys in accuracy.
 */

export interface Question {
  id: string;
  categoryId: string;
  /** A whole question in plain words, no jargon. */
  label: string;
  /** What one unit is: "miles", "pounds", "meals". Shown beside the number. */
  unit: string;
  /** How much one press of the plus button adds. */
  step: number;
  max: number;
  /** kg CO2e per year for one of these. */
  kgPerUnit: number;
}

export interface Category {
  id: string;
  name: string;
  /** One short sentence, readable aloud. */
  blurb: string;
  /**
   * kg CO2e per person per year that applies whatever is answered. Only food
   * uses this: everybody eats, so a household answering zero to every food
   * question still has a food footprint.
   */
  baselinePerPerson?: number;
  baselineLabel?: string;
}

export interface Band {
  letter: "A" | "B" | "C" | "D" | "E" | "F" | "G";
  /** Plain words, not a technical grade. */
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
  /**
   * The part of `kg` that applies no matter what was answered. Advice ranks on
   * `kg - baselineKg`, because telling someone their biggest area is food when
   * most of that figure is the unavoidable allowance is not useful.
   */
  baselineKg: number;
}

export interface AdviceAction {
  /** One short line, in everyday words. What to actually do. */
  text: string;
  /**
   * What it saves in a year, rounded hard. Worked out from this household's
   * own answers, never written by the model.
   */
  savingKg: number;
  /**
   * Pounds off the bill in a year, where it can be worked out honestly from a
   * bill they gave us. Left out otherwise — a made-up saving is worse than no
   * saving, because the first time one is wrong nobody believes the next.
   */
  savingPounds?: number;
}

export interface Advice {
  /** One sentence saying where most of it comes from. */
  summary: string;
  /** The total turned into something a person can picture. */
  comparison: string;
  /** Three short actions. One idea each, no paragraphs. */
  actions: AdviceAction[];
  source: "openai" | "built-in";
  model?: string;
}

export interface Household {
  size: number;
}

export interface FootprintResult {
  totalKg: number;
  perPersonKg: number;
  band: Band;
  /**
   * 0 to 1, where 1 is a footprint the planet could sustain. Drives how green
   * or how dried out the grass is drawn.
   */
  health: number;
  categories: CategoryResult[];
}

export interface Assessment extends FootprintResult {
  id: string;
  createdAt: string;
  household: Household;
  answers: Record<string, number>;
  advice: Advice;
}
