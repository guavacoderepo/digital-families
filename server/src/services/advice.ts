import OpenAI from "openai";
import { TARIFF, categoriesById, questionsById } from "../domain/questions.js";
import type {
  Advice,
  AdviceAction,
  FootprintResult,
  Household,
} from "../domain/types.js";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/**
 * HOW THIS IS PUT TOGETHER
 * ------------------------
 * Every number a household is shown is worked out here, from their own
 * answers. The model is never asked for one. All it does is rewrite the
 * wording so it sounds like a person talking, and it is given the finished
 * figures to write around.
 *
 * That split matters. A language model asked to estimate a saving will produce
 * a confident, plausible, wrong number, and the first time somebody checks one
 * against their bill the whole thing stops being believed.
 */

const SYSTEM_PROMPT = `You write the closing advice for the Digital Families Programme, a
community scheme that helps households work out the carbon their home creates.

Who is reading: mostly women running a household. Many left school early. Many are
watching every pound. They are not stupid and they will know at once if you talk down
to them.

How to write:
- Short sentences. Everyday words. Around 15 words a line, never more than 25.
- Never write "emissions", "carbon footprint", "sustainable", "reduce", "offset",
  "CO2", "eco" or "green" as a virtue word. Say "carbon" only if you need to.
- Talk about the home as it actually is: the bill, the shopping, the wash, the week.
- Warm and matter of fact. Never preachy. Never scold. Never congratulate.
- Do not assume they have children, a partner, a car, a garden, or a spare penny.
- Do not tell them to buy anything expensive. No heat pumps, no electric cars, no
  solar panels, no new appliances.
- Never invent grants, prices or scheme names.

NUMBERS: every figure you are given is already correct and already checked. Keep each
one exactly as it is. Never add a number of your own, never change one, never round one.

You are given a list of suggestions that already fit this household. Rewrite each one
in your own warmer words, in the same order, the same number of them. Keep the meaning
and keep any figure that appears in it.

Return ONLY a JSON object, no markdown fences:
{
  "summary": "one sentence, under 25 words, saying where most of it comes from",
  "actions": ["first suggestion rewritten", "second", "third"]
}`;

/** Round a saving hard. These are estimates and false precision oversells them. */
function roundKg(kg: number): number {
  if (kg <= 0) return 0;
  if (kg < 100) return Math.round(kg / 10) * 10;
  return Math.round(kg / 50) * 50;
}

function roundPounds(pounds: number): number {
  return Math.round(pounds / 5) * 5;
}

/** Turn a saving in electricity carbon back into pounds off the bill. */
function electricityPounds(kg: number): number {
  return (
    (kg / TARIFF.electricityKgPerKwh) * (TARIFF.electricityPencePerKwh / 100)
  );
}

/** Same for gas. Oil is bought in litres, so we never guess a price for it. */
function gasPounds(kg: number): number {
  return (kg / TARIFF.gasKgPerKwh) * (TARIFF.gasPencePerKwh / 100);
}

const kgOf = (id: string, answers: Record<string, number>): number => {
  const question = questionsById.get(id);
  if (!question) return 0;
  return (answers[id] ?? 0) * question.kgPerUnit;
};

interface Tip {
  /** Only offer this if the household is actually doing the thing. */
  when: (a: Record<string, number>) => boolean;
  /** Worked out from their own answers. Return null to skip the tip. */
  build: (a: Record<string, number>) => AdviceAction | null;
}

const TIPS: Record<string, Tip[]> = {
  home: [
    {
      when: (a) => (a.gas_bill_month ?? 0) + (a.heating_oil_year ?? 0) > 0,
      build: (a) => {
        // A degree off the thermostat takes roughly 7% off the heating.
        const heatingKg =
          kgOf("gas_bill_month", a) + kgOf("heating_oil_year", a);
        const savedKg = heatingKg * 0.07;
        const savedPounds = gasPounds(kgOf("gas_bill_month", a) * 0.07);
        return {
          text:
            savedPounds >= 10
              ? `Turn the heating down by one degree. Most people never notice, and it takes about £${roundPounds(savedPounds)} a year off the gas bill.`
              : "Turn the heating down by one degree. Most people never notice the difference.",
          savingKg: roundKg(savedKg),
          savingPounds:
            savedPounds >= 10 ? roundPounds(savedPounds) : undefined,
        };
      },
    },
    {
      when: (a) => (a.electricity_bill_month ?? 0) >= 40,
      build: () => ({
        text: "Ask your supplier about a tariff backed by wind and solar. It often costs no more than the one you are on.",
        // Deliberately no figure. A certificate-backed tariff changes what your
        // supplier is contracted to buy, not what comes down the wire tonight,
        // and whether it causes any new wind or solar to be built is disputed.
        // Putting a big number on it would push every other suggestion down the
        // list on the strength of a claim we cannot defend.
        savingKg: 0,
      }),
    },
  ],
  transport: [
    {
      when: (a) => (a.flights_year ?? 0) >= 1,
      build: () => ({
        text: "One return flight fewer in a year. Flying is heavy for the few hours it takes.",
        savingKg: 400,
      }),
    },
    {
      when: (a) => (a.car_miles_week ?? 0) >= 20,
      build: (a) => {
        // The shortest regular trips are the easiest to swap and the most
        // wasteful per mile, because the engine never warms up.
        const milesSwapped = Math.min(a.car_miles_week ?? 0, 12);
        return {
          text: `Leave the car at home for one regular trip a week. Short journeys burn the most fuel for the distance.`,
          savingKg: roundKg(milesSwapped * TARIFF.carKgPerMile * 52),
        };
      },
    },
  ],
  food: [
    {
      when: (a) => (a.red_meat_meals_week ?? 0) >= 2,
      build: () => ({
        text: "Swap one beef or lamb dinner a week for chicken, fish, eggs or beans. Beef and lamb are far heavier than anything else on the plate.",
        savingKg: roundKg(234),
      }),
    },
    {
      when: (a) => (a.meals_out_week ?? 0) >= 2,
      build: () => ({
        text: "One takeaway fewer a week. It adds up over a year, and so does the money.",
        savingKg: roundKg(166),
      }),
    },
  ],
  water: [
    {
      when: (a) => (a.showers_week ?? 0) >= 7,
      build: (a) => {
        const savedKg = kgOf("showers_week", a) * 0.4;
        return {
          text: "Keep showers to about four minutes. Nearly all of the cost is heating the water, so the length is what matters.",
          savingKg: roundKg(savedKg),
        };
      },
    },
    {
      when: (a) => (a.washing_loads_week ?? 0) >= 3,
      build: (a) => {
        const savedKg = kgOf("washing_loads_week", a) * 0.3;
        const savedPounds = electricityPounds(savedKg);
        return {
          text:
            savedPounds >= 10
              ? `Wash at 30 degrees and wait for a full load. Today's powder is made for cold water, and it saves around £${roundPounds(savedPounds)} a year.`
              : "Wash at 30 degrees and wait for a full load. Today's powder is made for cold water.",
          savingKg: roundKg(savedKg),
          savingPounds:
            savedPounds >= 10 ? roundPounds(savedPounds) : undefined,
        };
      },
    },
  ],
  digital: [
    {
      when: (a) => (a.always_on_devices ?? 0) >= 2,
      build: (a) => {
        const savedKg = kgOf("always_on_devices", a) * 0.5;
        const savedPounds = electricityPounds(savedKg);
        return {
          text:
            savedPounds >= 10
              ? `Switch off at the wall whatever nobody is using overnight. That is roughly £${roundPounds(savedPounds)} a year sitting on standby.`
              : "Switch off at the wall whatever nobody is using overnight.",
          savingKg: roundKg(savedKg),
          savingPounds:
            savedPounds >= 10 ? roundPounds(savedPounds) : undefined,
        };
      },
    },
  ],
  shopping: [
    {
      when: (a) => (a.devices_year ?? 0) >= 1,
      build: (a) => ({
        text: "Keep the phone or tablet one more year. Nearly all of its carbon was spent before it reached the shop, and a new battery costs a fraction of a new one.",
        savingKg: roundKg(kgOf("devices_year", a) * 0.5),
      }),
    },
    {
      when: (a) => (a.clothes_year ?? 0) >= 10,
      build: (a) => ({
        text: "Buy some of the clothes second hand. Charity shops, Vinted and swaps with friends all count.",
        savingKg: roundKg(kgOf("clothes_year", a) * 0.45),
      }),
    },
  ],
  waste: [
    {
      when: (a) => (a.rubbish_bags_week ?? 0) >= 2,
      build: (a) => ({
        text: "Food scraps go in the caddy, not the black bin. Food rotting in a tip is the worst thing in there.",
        savingKg: roundKg(kgOf("rubbish_bags_week", a) * 0.25),
      }),
    },
    {
      when: (a) => (a.rubbish_bags_week ?? 0) > (a.recycling_bags_week ?? 0),
      build: (a) => ({
        text: "Put a second box in the kitchen so the recycling never ends up in the rubbish bag.",
        savingKg: roundKg(kgOf("rubbish_bags_week", a) * 0.2),
      }),
    },
  ],
  lifestyle: [
    {
      when: (a) => (a.hotel_nights_year ?? 0) >= 5,
      build: (a) => ({
        text: "A break closer to home does the same job without the travel.",
        savingKg: roundKg(kgOf("hotel_nights_year", a) * 0.3),
      }),
    },
  ],
};

/**
 * The total, turned into something a person can actually picture.
 *
 * Kilograms of carbon are invisible and weightless to most people; miles in a
 * car are not. The conversion uses the same factor the household was scored
 * on, so the comparison is internally consistent rather than decorative.
 */
function buildComparison(result: FootprintResult): string {
  const miles = Math.round(result.totalKg / TARIFF.carKgPerMile / 100) * 100;
  const pretty = miles.toLocaleString("en-GB");
  const laps = miles / 24_900;

  if (laps >= 1.75) {
    return `That is like driving a car round the world about ${Math.round(laps)} times.`;
  }
  if (laps >= 1.25) {
    return `That is like driving a car ${pretty} miles — more than once round the world.`;
  }
  if (laps >= 0.75) {
    return `That is like driving a car ${pretty} miles — near enough right round the world.`;
  }
  if (laps >= 0.4) {
    return `That is like driving a car ${pretty} miles — not far off halfway round the world.`;
  }
  return `That is like driving a car about ${pretty} miles.`;
}

/**
 * Picks the actions and works out every figure. This always runs — OpenAI only
 * ever rewrites the wording afterwards.
 */
export function builtInAdvice(
  result: FootprintResult,
  household: Household,
  answers: Record<string, number> = {},
): Advice {
  // Rank on the part they can change. Food carries an allowance for simply
  // eating, and leading with that would send everyone to the same useless
  // first line.
  const changeable = (c: (typeof result.categories)[number]) =>
    c.kg - c.baselineKg;
  const ranked = [...result.categories]
    .filter((c) => changeable(c) > 0)
    .sort((a, b) => changeable(b) - changeable(a));

  // At most one suggestion per area, so the three cover three different parts
  // of the week rather than three settings on the same boiler. Within an area,
  // take whichever saves most; then order the three by size.
  const picked: AdviceAction[] = ranked
    .map(
      (category) =>
        (TIPS[category.categoryId] ?? [])
          .filter((tip) => tip.when(answers))
          .map((tip) => tip.build(answers))
          .filter((action): action is AdviceAction => action !== null)
          .sort((a, b) => b.savingKg - a.savingKg)[0],
    )
    .filter((action): action is AdviceAction => action !== undefined)
    .sort((a, b) => b.savingKg - a.savingKg)
    .slice(0, 3);

  const actions = [...picked];
  const nothingToChange = actions.length === 0;

  if (nothingToChange) {
    actions.push({
      text: "There is very little here to change. Your home is already lighter than most.",
      savingKg: 0,
    });
    actions.push({
      text: "Keeping the heating steady and the bins sorted holds it where it is.",
      savingKg: 0,
    });
    actions.push({
      text: "Show a neighbour how to do this and you double the good it does.",
      savingKg: 0,
    });
  }

  const biggest = ranked[0];
  const perPerson = Math.round(result.perPersonKg);
  const comparedToTypical =
    perPerson < 5000
      ? "below"
      : perPerson > 8000
        ? "above"
        : "about the same as";

  const summary = nothingToChange
    ? `Your home already sits ${comparedToTypical} the usual figure for the UK, and nothing here stands out as an easy saving.`
    : biggest
      ? `Most of it comes from ${biggest.name.toLowerCase()}, and your home sits ${comparedToTypical} the usual figure for the UK.`
      : `This is only the allowance for everyday food and drink, which everybody has.`;

  return {
    summary,
    comparison: buildComparison(result),
    actions,
    source: "built-in",
  };
}

/**
 * Takes the model's rewrite only if it kept the shape: same number of actions,
 * in the same order. Our figures are then reattached to them, so a rewrite can
 * never change what a household is promised.
 */
function applyRewrite(raw: unknown, base: Advice): Advice | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.summary !== "string" || !Array.isArray(obj.actions))
    return null;

  const rewritten = obj.actions.filter(
    (line): line is string =>
      typeof line === "string" && line.trim().length > 0,
  );
  if (rewritten.length !== base.actions.length) return null;

  return {
    summary: obj.summary.trim(),
    comparison: base.comparison,
    actions: base.actions.map((action, index) => ({
      ...action,
      text: rewritten[index]!.trim(),
    })),
    source: "openai",
    model: MODEL,
  };
}

function buildUserPrompt(
  result: FootprintResult,
  household: Household,
  answers: Record<string, number>,
  base: Advice,
): string {
  const lines: string[] = [];

  lines.push(
    `${household.size} ${household.size === 1 ? "person lives" : "people live"} in this home.`,
  );
  lines.push(`Their home creates ${result.totalKg} kg of carbon a year.`);
  lines.push(
    `That is ${result.perPersonKg} kg each. A typical person in the UK is about 6500 kg.`,
  );
  lines.push("");
  lines.push("Where it comes from, biggest first:");

  for (const category of [...result.categories].sort((a, b) => b.kg - a.kg)) {
    if (category.kg === 0) continue;
    const note =
      category.baselineKg > 0
        ? ` — ${category.baselineKg} kg of that is a fixed allowance nobody can avoid, so never suggest changing that part`
        : "";
    lines.push(
      `- ${category.name}: ${category.kg} kg (${Math.round(category.share * 100)}%)${note}`,
    );
  }

  lines.push("");
  lines.push("What this household told us:");
  for (const [id, value] of Object.entries(answers)) {
    const question = questionsById.get(id);
    if (!question || !value) continue;
    lines.push(`- ${question.label} ${value} ${question.unit}`);
  }
  lines.push("Anything not listed is zero. Never suggest changing it.");

  lines.push("");
  lines.push(
    "Rewrite these suggestions, in this order, keeping every figure exactly:",
  );
  base.actions.forEach((action, index) => {
    const saving =
      action.savingKg > 0 ? ` (saves about ${action.savingKg} kg a year)` : "";
    lines.push(`${index + 1}. ${action.text}${saving}`);
  });

  return lines.join("\n");
}

export async function generateAdvice(
  result: FootprintResult,
  household: Household,
  answers: Record<string, number>,
): Promise<Advice> {
  const base = builtInAdvice(result, household, answers);
  if (!client) return base;

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.5,
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: buildUserPrompt(result, household, answers, base),
        },
      ],
    });

    const text = completion.choices[0]?.message?.content ?? "";
    const cleaned = text
      .replace(/^```(?:json)?/m, "")
      .replace(/```$/m, "")
      .trim();
    return applyRewrite(JSON.parse(cleaned), base) ?? base;
  } catch (error) {
    console.error(
      "[advice] OpenAI call failed, using the built-in wording:",
      error,
    );
    return base;
  }
}

export const openAiConfigured = client !== null;
export const knownCategoryIds = [...categoriesById.keys()];
