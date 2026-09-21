import OpenAI from "openai";
import { TARIFF, categoriesById, questionsById } from "../domain/questions.js";
import type {
  Advice,
  AdviceAction,
  FootprintResult,
  Household,
} from "../domain/types.js";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const WANTED = 4;

const DEBUG = process.env.ADVICE_DEBUG === "1";

const MAX_IN_FLIGHT = Number(process.env.ADVICE_MAX_IN_FLIGHT ?? 8);
const QUEUE_TIMEOUT_MS = Number(process.env.ADVICE_QUEUE_TIMEOUT_MS ?? 8000);
const REQUEST_TIMEOUT_MS = Number(
  process.env.ADVICE_REQUEST_TIMEOUT_MS ?? 12000,
);

const rawKey = process.env.OPENAI_API_KEY;
const client = rawKey ? new OpenAI({ apiKey: rawKey }) : null;

/** Quiet by default. Only warnings and errors are always printed. */
const log = (message: string) => {
  if (DEBUG) console.log(`[advice] ${message}`);
};
const warn = (message: string) => console.warn(`[advice] ${message}`);

/* -------------------------------------------------------------------------- */
/* Concurrency guard                                                          */
/* -------------------------------------------------------------------------- */

let inFlight = 0;
const waiting: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const index = waiting.indexOf(grant);
      if (index !== -1) waiting.splice(index, 1);
      reject(new Error("queue timeout"));
    }, QUEUE_TIMEOUT_MS);

    const grant = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inFlight++;
      resolve();
    };
    waiting.push(grant);
  });
}

function releaseSlot() {
  inFlight--;
  const next = waiting.shift();
  if (next) next();
}

/* -------------------------------------------------------------------------- */
/* Prompt                                                                     */
/* -------------------------------------------------------------------------- */

const BANNED_WORDS = [
  "emissions",
  "carbon footprint",
  "sustainable",
  "reduce",
  "offset",
  "co2",
  "eco",
  "green",
  "significant",
  "utilise",
  "purchase",
  "approximately",
  "sacrificing",
  "comfort",
  "energy",
  "waste",
];

const SYSTEM_PROMPT = `You write short carbon-saving advice for the Digital Families Programme.

Reader: mostly women running a household, many on a tight budget, many left
school at sixteen. Plain English. Never preachy, never congratulatory. Do not
assume children, a partner, a car, a garden, or spare money.

Your job: pick the ${WANTED} changes that would cut this household's carbon
the most, and write each one. Where the carbon is concentrated, several of
your suggestions may come from the same part of their life. That is correct.
Do not spread the suggestions out for the sake of variety.

Each suggestion is exactly two sentences:
1. What to do. 2. Why it is worth doing. Ten to fifteen words per sentence,
never more than twenty. The second sentence is the reason and is never dropped.

Banned words: emissions, carbon footprint, sustainable, reduce, offset, CO2,
eco, green. Also banned: significant, utilise, purchase, approximately,
sacrificing, comfort, energy, waste. Use plain words instead.

Never suggest buying anything expensive. Never invent a grant, price, or scheme.
Never write a number in a suggestion.

Return ONLY JSON, no fences:
{"summary":"<25 words, where most of it comes from>","actions":["...","...","...","..."]}
"actions" must have exactly ${WANTED} strings.`;

function buildUserPrompt(
  result: FootprintResult,
  household: Household,
  answers: Record<string, number>,
): string {
  const { score, min, max } = scoreFor(result);

  const cats = [...result.categories]
    .filter((c) => c.kg > 0)
    .sort((a, b) => b.kg - a.kg)
    .map((c) => {
      const changeable = c.kg - c.baselineKg;
      const fixed =
        c.baselineKg > 0
          ? `${c.baselineKg}kg fixed, cannot change`
          : "none fixed";
      return `${c.name}: ${c.kg}kg (${changeable}kg changeable, ${fixed})`;
    })
    .join("\n");

  const told = Object.entries(answers)
    .filter(([id, v]) => v && questionsById.has(id))
    .map(([id, v]) => {
      const q = questionsById.get(id)!;
      return `- ${q.label}: ${v}${q.unit ? ` ${q.unit}` : ""}`;
    })
    .join("\n");

  return [
    `${household.size} people in the home.`,
    `Total ${result.totalKg}kg of carbon a year, ${result.perPersonKg}kg each.`,
    `UK typical is about 6500kg each. Their score: ${score}/100 (scale ${min}–${max}kg per person).`,
    ``,
    `Where their carbon comes from, biggest first:`,
    cats || "(nothing counted)",
    ``,
    `What they told us:`,
    told || "(nothing)",
    ``,
    `Anything not listed is zero. Pick the ${WANTED} changes that would cut the most carbon.`,
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Numbers                                                                    */
/* -------------------------------------------------------------------------- */

function roundKg(kg: number): number {
  if (kg <= 0) return 0;
  if (kg < 100) return Math.round(kg / 10) * 10;
  return Math.round(kg / 50) * 50;
}

function roundPounds(pounds: number): number {
  return Math.round(pounds / 5) * 5;
}

function electricityPounds(kg: number): number {
  return (
    (kg / TARIFF.electricityKgPerKwh) * (TARIFF.electricityPencePerKwh / 100)
  );
}

function gasPounds(kg: number): number {
  return (kg / TARIFF.gasKgPerKwh) * (TARIFF.gasPencePerKwh / 100);
}

const kgOf = (id: string, answers: Record<string, number>): number => {
  const question = questionsById.get(id);
  if (!question) return 0;
  return (answers[id] ?? 0) * question.kgPerUnit;
};

function scoreFor(result: FootprintResult): {
  score: number;
  min: number;
  max: number;
} {
  const perPerson = result.perPersonKg;
  const min = 2000;
  const max = 12000;
  const clamped = Math.max(min, Math.min(max, perPerson));
  const score = Math.round(100 - ((clamped - min) / (max - min)) * 100);
  return { score, min, max };
}

/* -------------------------------------------------------------------------- */
/* Fallback advice                                                            */
/* -------------------------------------------------------------------------- */

interface Fallback {
  categoryId: string;
  when: (a: Record<string, number>) => boolean;
  build: (a: Record<string, number>) => AdviceAction | null;
}

const FALLBACKS: Fallback[] = [
  {
    categoryId: "home",
    when: (a) => (a.gas_bill_month ?? 0) + (a.heating_oil_year ?? 0) > 0,
    build: (a) => {
      const heatingKg = kgOf("gas_bill_month", a) + kgOf("heating_oil_year", a);
      const savedPounds = gasPounds(kgOf("gas_bill_month", a) * 0.07);
      const showMoney = savedPounds >= 10;
      return {
        text: showMoney
          ? `Turn the heating down by one degree. Most people never feel it, and it takes about £${roundPounds(savedPounds)} a year off the gas bill.`
          : "Turn the heating down by one degree. Most people never feel the difference.",
        savingKg: roundKg(heatingKg * 0.07),
        savingPounds: showMoney ? roundPounds(savedPounds) : undefined,
      };
    },
  },
  {
    categoryId: "home",
    when: (a) => (a.gas_bill_month ?? 0) + (a.heating_oil_year ?? 0) > 0,
    build: (a) => {
      const heatingKg = kgOf("gas_bill_month", a) + kgOf("heating_oil_year", a);
      return {
        text: "Block the draughts round the doors and the letterbox. A few pounds of foam strip stops heat you have paid for going straight out.",
        savingKg: roundKg(heatingKg * 0.05),
      };
    },
  },
  {
    categoryId: "transport",
    when: (a) => (a.flights_year ?? 0) >= 1,
    build: () => ({
      text: "Take one return flight less this year. One flight puts out more than most people realise.",
      savingKg: 400,
    }),
  },
  {
    categoryId: "transport",
    when: (a) => (a.car_miles_week ?? 0) >= 20,
    build: (a) => ({
      text: "Leave the car at home once a week, for a short trip you could walk or take the bus. Short trips use the most petrol.",
      savingKg: roundKg(
        Math.min(a.car_miles_week ?? 0, 12) * TARIFF.carKgPerMile * 52,
      ),
    }),
  },
  {
    categoryId: "food",
    when: (a) => (a.red_meat_meals_week ?? 0) >= 2,
    build: () => ({
      text: "Have one dinner a week without beef or lamb. Chicken, fish, eggs or beans instead. No other food adds as much carbon as beef and lamb.",
      savingKg: roundKg(234),
    }),
  },
  {
    categoryId: "food",
    when: (a) => (a.meals_out_week ?? 0) >= 2,
    build: () => ({
      text: "One takeaway less a week. It adds up over a year, and you keep the money as well.",
      savingKg: roundKg(166),
    }),
  },
  {
    categoryId: "water",
    when: (a) => (a.showers_week ?? 0) >= 7,
    build: (a) => ({
      text: "Keep showers to about four minutes. It is heating the water that costs, so a shorter shower is what saves.",
      savingKg: roundKg(kgOf("showers_week", a) * 0.4),
    }),
  },
  {
    categoryId: "water",
    when: (a) => (a.washing_loads_week ?? 0) >= 3,
    build: (a) => {
      const savedKg = kgOf("washing_loads_week", a) * 0.3;
      const savedPounds = electricityPounds(savedKg);
      const showMoney = savedPounds >= 10;
      return {
        text: showMoney
          ? `Wash at 30 degrees, and wait until the machine is full. Powder works fine in cold water now, and it saves about £${roundPounds(savedPounds)} a year.`
          : "Wash at 30 degrees, and wait until the machine is full. Powder works fine in cold water now.",
        savingKg: roundKg(savedKg),
        savingPounds: showMoney ? roundPounds(savedPounds) : undefined,
      };
    },
  },
  {
    categoryId: "digital",
    when: (a) => (a.always_on_devices ?? 0) >= 2,
    build: (a) => {
      const savedKg = kgOf("always_on_devices", a) * 0.5;
      const savedPounds = electricityPounds(savedKg);
      const showMoney = savedPounds >= 10;
      return {
        text: showMoney
          ? `Switch things off at the wall overnight instead of leaving them on standby. That is about £${roundPounds(savedPounds)} a year doing nothing.`
          : "Switch things off at the wall overnight instead of leaving them on standby.",
        savingKg: roundKg(savedKg),
        savingPounds: showMoney ? roundPounds(savedPounds) : undefined,
      };
    },
  },
  {
    categoryId: "shopping",
    when: (a) => (a.devices_year ?? 0) >= 1,
    build: (a) => ({
      text: "Keep your phone or tablet one more year. Most of its carbon is used making it, long before you buy it.",
      savingKg: roundKg(kgOf("devices_year", a) * 0.5),
    }),
  },
  {
    categoryId: "shopping",
    when: (a) => (a.clothes_year ?? 0) >= 10,
    build: (a) => ({
      text: "Buy some of your clothes second hand. Charity shops, Vinted, or a swap with friends all count.",
      savingKg: roundKg(kgOf("clothes_year", a) * 0.45),
    }),
  },
  {
    categoryId: "waste",
    when: (a) => (a.rubbish_bags_week ?? 0) >= 2,
    build: (a) => ({
      text: "Put food scraps in the food bin, not the black bin. Food buried in the ground rots and gives off a harmful gas.",
      savingKg: roundKg(kgOf("rubbish_bags_week", a) * 0.25),
    }),
  },
  {
    categoryId: "waste",
    when: (a) => (a.rubbish_bags_week ?? 0) > (a.recycling_bags_week ?? 0),
    build: (a) => ({
      text: "Keep a second box in the kitchen for recycling. Then it never ends up in the rubbish bag by mistake.",
      savingKg: roundKg(kgOf("rubbish_bags_week", a) * 0.2),
    }),
  },
  {
    categoryId: "lifestyle",
    when: (a) => (a.hotel_nights_year ?? 0) >= 5,
    build: (a) => ({
      text: "Take a break closer to home. You still get away, without the long journey.",
      savingKg: roundKg(kgOf("hotel_nights_year", a) * 0.3),
    }),
  },
];

const FILLERS: AdviceAction[] = [
  {
    text: "Your home already uses less than most. The job now is keeping it there.",
    savingKg: 0,
  },
  {
    text: "Keep the heating steady and the bins sorted, and it stays as it is.",
    savingKg: 0,
  },
  {
    text: "Check the bill once a month. You spot a jump much sooner that way.",
    savingKg: 0,
  },
  {
    text: "Show a neighbour how to do this, and it counts twice.",
    savingKg: 0,
  },
];

function buildComparison(result: FootprintResult): string {
  const miles = Math.round(result.totalKg / TARIFF.carKgPerMile / 100) * 100;
  const pretty = miles.toLocaleString("en-GB");
  const laps = miles / 24_900;

  if (laps >= 1.75) {
    return `That is the same as driving a car round the world about ${Math.round(laps)} times.`;
  }
  if (laps >= 1.2) {
    return `That is the same as driving a car ${pretty} miles — more than once round the world.`;
  }
  if (laps >= 0.8) {
    return `That is the same as driving a car ${pretty} miles — near enough right round the world.`;
  }
  return `That is the same as driving a car about ${pretty} miles.`;
}

function buildSummary(result: FootprintResult): string {
  const changeable = (c: (typeof result.categories)[number]) =>
    c.kg - c.baselineKg;
  const ranked = [...result.categories]
    .filter((c) => changeable(c) > 0)
    .sort((a, b) => changeable(b) - changeable(a));

  const biggest = ranked[0];
  const perPerson = Math.round(result.perPersonKg);
  const comparedToTypical =
    perPerson < 5000
      ? "less than"
      : perPerson > 8000
        ? "more than"
        : "about the same as";

  if (!biggest) {
    return `Your home already uses ${comparedToTypical} most homes in the UK. The job now is keeping it there.`;
  }
  return `Most of it comes from ${biggest.name.toLowerCase()}. Your home uses ${comparedToTypical} most homes in the UK.`;
}

export function builtInAdvice(
  result: FootprintResult,
  household: Household,
  answers: Record<string, number> = {},
): Advice {
  log(
    `household of ${household.size} · ${result.totalKg} kg · ${result.perPersonKg} kg each · band ${result.band.letter}`,
  );

  const candidates = FALLBACKS.filter((f) => f.when(answers))
    .map((f) => f.build(answers))
    .filter((a): a is AdviceAction => a !== null)
    .sort((a, b) => b.savingKg - a.savingKg);

  const actions = candidates.slice(0, WANTED);
  for (const filler of FILLERS) {
    if (actions.length >= WANTED) break;
    actions.push(filler);
  }

  return {
    summary: buildSummary(result),
    comparison: buildComparison(result),
    actions,
    source: "built-in",
  };
}

/* -------------------------------------------------------------------------- */
/* Model reply handling                                                       */
/* -------------------------------------------------------------------------- */

function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d[\d,]*/g)].map((m) => m[0].replace(/,/g, ""));
}

function allowedNumbersFromPrompt(
  result: FootprintResult,
  answers: Record<string, number>,
): Set<string> {
  const allowed = new Set<string>();
  allowed.add(String(result.totalKg));
  allowed.add(String(result.perPersonKg));
  allowed.add("6500");
  allowed.add("2000");
  allowed.add("12000");
  allowed.add(String(scoreFor(result).score));

  for (const category of result.categories) {
    allowed.add(String(category.kg));
    allowed.add(String(category.baselineKg));
    allowed.add(String(Math.round(category.share * 100)));
    allowed.add(String(Math.round(category.kg - category.baselineKg)));
  }
  for (const [id, value] of Object.entries(answers)) {
    if (!questionsById.get(id) || !value) continue;
    allowed.add(String(value));
  }
  for (const fact of ["400", "230", "234", "170", "166", "7", "5"]) {
    allowed.add(fact);
  }

  const p1 = gasPounds(kgOf("gas_bill_month", answers) * 0.07);
  if (p1 >= 10) allowed.add(String(roundPounds(p1)));
  const p2 = electricityPounds(kgOf("washing_loads_week", answers) * 0.3);
  if (p2 >= 10) allowed.add(String(roundPounds(p2)));
  const p3 = electricityPounds(kgOf("always_on_devices", answers) * 0.5);
  if (p3 >= 10) allowed.add(String(roundPounds(p3)));

  return allowed;
}

function voiceCheck(text: string): string | null {
  const lower = text.toLowerCase();
  for (const word of BANNED_WORDS) {
    const pattern = new RegExp(`\\b${word}\\b`, "i");
    if (pattern.test(lower)) {
      return `banned word "${word}"`;
    }
  }

  const sentenceCount = (text.match(/[.!?](\s|$)/g) ?? []).length;
  if (sentenceCount < 2) {
    return `only ${sentenceCount} sentence(s), needs two`;
  }
  if (sentenceCount > 3) {
    return `${sentenceCount} sentences, too many`;
  }

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean).length;
    if (words > 22) {
      return `a sentence is ${words} words, over the limit`;
    }
    if (words < 6) {
      return `a sentence is ${words} words, too short`;
    }
  }

  if (/^\s*(step\s*\d|\d+\.)\s/i.test(text)) {
    return `looks like it kept a step number`;
  }

  return null;
}

function applyGenerated(
  raw: unknown,
  base: Advice,
  result: FootprintResult,
  answers: Record<string, number>,
): Advice | null {
  if (typeof raw !== "object" || raw === null) {
    warn(`reply was not an object`);
    return null;
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.summary !== "string") {
    warn(`reply had no "summary"`);
    return null;
  }
  if (!Array.isArray(obj.actions)) {
    warn(`reply had no "actions" array`);
    return null;
  }

  const allowed = allowedNumbersFromPrompt(result, answers);
  const accepted: AdviceAction[] = [];

  for (const line of obj.actions) {
    const text = typeof line === "string" ? line.trim() : "";
    if (!text) continue;

    if (/\bkg\b/i.test(text)) {
      warn(`dropped a line that wrote a kg figure`);
      continue;
    }
    const unlisted = numbersIn(text).filter((n) => !allowed.has(n));
    if (unlisted.length > 0) {
      warn(`dropped a line with unlisted number(s): ${unlisted.join(", ")}`);
      continue;
    }

    const problem = voiceCheck(text);
    if (problem) {
      warn(`dropped a line (${problem}): "${text.slice(0, 80)}…"`);
      continue;
    }

    accepted.push({ text, savingKg: 0 });
  }

  if (accepted.length === 0) {
    warn(`no usable lines came back`);
    return null;
  }

  const seen = new Set<string>();
  const unique: AdviceAction[] = [];
  for (const action of accepted) {
    const key = action.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(action);
  }

  const actions = unique.slice(0, WANTED);
  if (actions.length < WANTED) {
    const fallback = builtInAdvice(result, { size: 1 } as Household, answers);
    for (const action of fallback.actions) {
      if (actions.length >= WANTED) break;
      if (actions.some((a) => a.text === action.text)) continue;
      actions.push(action);
    }
  }
  for (const filler of FILLERS) {
    if (actions.length >= WANTED) break;
    actions.push(filler);
  }

  return {
    summary: obj.summary.trim(),
    comparison: base.comparison,
    actions,
    source: "openai",
    model: MODEL,
  };
}

function describeFailure(error: unknown): string {
  const e = error as {
    status?: number;
    code?: string;
    name?: string;
    message?: string;
  };
  const status = typeof e?.status === "number" ? e.status : undefined;
  const message = e?.message ?? String(error);

  const hint =
    status === 401
      ? `key rejected — check it is current and has no quotes or spaces`
      : status === 403
        ? `this key cannot use ${MODEL}`
        : status === 404
          ? `no model called "${MODEL}" on this account`
          : status === 429
            ? `rate limited or out of credit — check billing`
            : status !== undefined && status >= 500
              ? `OpenAI had a server problem`
              : /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(
                    message,
                  )
                ? `could not reach api.openai.com`
                : error instanceof SyntaxError
                  ? `the reply was not valid JSON`
                  : `see the message above`;

  return `${status ?? "no HTTP status"}${e?.code ? ` ${e.code}` : ""}: ${message}\n[advice]   → ${hint}`;
}

export async function generateAdvice(
  result: FootprintResult,
  household: Household,
  answers: Record<string, number>,
): Promise<Advice> {
  const base = builtInAdvice(result, household, answers);

  if (!client) {
    log(`done · source=built-in (no key)`);
    return base;
  }

  try {
    await acquireSlot();
  } catch {
    warn(`queue full, using built-in`);
    return base;
  }

  try {
    const prompt = buildUserPrompt(result, household, answers);
    if (DEBUG) {
      console.log(`[advice] --- prompt ---\n${prompt}\n[advice] --- end ---`);
    }

    const startedAt = Date.now();

    const completion = await client.chat.completions.create(
      {
        model: MODEL,
        temperature: 0.4,
        max_tokens: 500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );

    const elapsed = Date.now() - startedAt;
    const choice = completion.choices[0];
    const text = choice?.message?.content ?? "";

    log(
      `replied in ${elapsed} ms · ${completion.usage?.total_tokens ?? "?"} tokens`,
    );

    if (text.trim().length === 0) {
      warn(`empty reply, using built-in`);
      return base;
    }
    if (DEBUG) {
      console.log(`[advice] --- reply ---\n${text}\n[advice] --- end ---`);
    }

    const cleaned = text
      .replace(/^```(?:json)?/m, "")
      .replace(/```$/m, "")
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseError) {
      warn(`not valid JSON — ${(parseError as Error).message}`);
      return base;
    }

    const generated = applyGenerated(parsed, base, result, answers);
    return generated ?? base;
  } catch (error) {
    console.error(`[advice] call failed\n[advice]   ${describeFailure(error)}`);
    return base;
  } finally {
    releaseSlot();
  }
}

export const openAiConfigured = client !== null;
export const knownCategoryIds = [...categoriesById.keys()];