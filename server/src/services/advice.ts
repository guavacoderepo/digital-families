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
 * wording, and it is handed the finished figures to write around.
 *
 * That split matters. A language model asked to estimate a saving will produce
 * a confident, plausible, wrong number, and the first time somebody checks one
 * against their bill the whole thing stops being believed.
 *
 * Two or three suggestions, never a padded three. A third only appears when it
 * is worth the reading — see `worthShowing` below.
 */

const SYSTEM_PROMPT = `You write the closing advice for the Digital Families Programme, a
community scheme that helps households work out the carbon their home creates.

Who is reading: mostly women running a household. Many left school at sixteen or
earlier. Many are watching every pound. They are not stupid and they will know at
once if you talk down to them.

Plain English, and mean it:
- Short sentences. Ten to fifteen words. Never more than twenty.
- Always the shortest word that does the job. "Use", not "utilise". "Buy", not
  "purchase". "About", not "approximately".
- No word pictures. Do not call a food "heavy" or a home "lighter" or a saving
  "significant". Say the plain thing instead.
- Never write "emissions", "carbon footprint", "sustainable", "reduce", "offset",
  "CO2", "eco", or "green" as a virtue word. Say "carbon" only where you must.
- Name real things: the gas bill, the black bin, the washing machine, the shop.
- Warm and matter of fact. Never preachy. Never scold. Never congratulate.
- Do not assume they have children, a partner, a car, a garden, or a spare penny.
- Never suggest buying anything dear. No heat pumps, no electric cars, no solar
  panels, no new appliances.
- Never invent grants, prices or scheme names.

NUMBERS: every figure you are given is already correct and already checked. Keep each
one exactly as it is. Never add a number of your own, never change one, never round one.

You are given two or three suggestions that already fit this household. Rewrite each
one in warmer, plainer words. Same order. Exactly the same number of them. Keep the
meaning, and keep every figure that appears in it.

Return ONLY a JSON object, no markdown fences:
{
  "summary": "one sentence, under 25 words, saying where most of it comes from",
  "actions": ["first suggestion rewritten", "second", "and a third only if you were given one"]
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
      when: (a) => (a.electricity_bill_month ?? 0) >= 40,
      build: () => ({
        text: "Ask your electricity company to move you onto a wind and solar plan. It often costs no more than the one you are on.",
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
      build: (a) => {
        // Said in their own driving, which is a distance they can picture.
        const equivalentMiles =
          Math.round(400 / TARIFF.carKgPerMile / 100) * 100;
        const weeklyMiles = a.car_miles_week ?? 0;
        const weeks =
          weeklyMiles > 0 ? Math.round(equivalentMiles / weeklyMiles) : 0;
        const inTheirMiles =
          weeks >= 3 && weeks <= 104
            ? ` One flight puts out about as much as ${weeks} weeks of your driving.`
            : "";
        return {
          text: `Take one return flight less this year.${inTheirMiles}`,
          savingKg: 400,
        };
      },
    },
    {
      when: (a) => (a.car_miles_week ?? 0) >= 20,
      build: (a) => ({
        // Short trips are the easiest to swap and the worst per mile, because
        // the engine never gets up to temperature.
        text: "Leave the car at home once a week, for a short trip you could walk or take the bus. Short trips use the most petrol.",
        savingKg: roundKg(
          Math.min(a.car_miles_week ?? 0, 12) * TARIFF.carKgPerMile * 52,
        ),
      }),
    },
  ],
  food: [
    {
      when: (a) => (a.red_meat_meals_week ?? 0) >= 2,
      build: () => ({
        text: "Have one dinner a week without beef or lamb. Chicken, fish, eggs or beans instead. No other food adds as much carbon as beef and lamb.",
        savingKg: roundKg(234),
      }),
    },
    {
      when: (a) => (a.meals_out_week ?? 0) >= 2,
      build: () => ({
        text: "One takeaway less a week. It adds up over a year, and you keep the money as well.",
        savingKg: roundKg(166),
      }),
    },
  ],
  water: [
    {
      when: (a) => (a.showers_week ?? 0) >= 7,
      build: (a) => ({
        text: "Keep showers to about four minutes. It is heating the water that costs, so a shorter shower is what saves.",
        savingKg: roundKg(kgOf("showers_week", a) * 0.4),
      }),
    },
    {
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
  ],
  digital: [
    {
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
  ],
  shopping: [
    {
      when: (a) => (a.devices_year ?? 0) >= 1,
      build: (a) => ({
        text: "Keep your phone or tablet one more year. Most of its carbon is used making it, long before you buy it.",
        savingKg: roundKg(kgOf("devices_year", a) * 0.5),
      }),
    },
    {
      when: (a) => (a.clothes_year ?? 0) >= 10,
      build: (a) => ({
        text: "Buy some of your clothes second hand. Charity shops, Vinted, or a swap with friends all count.",
        savingKg: roundKg(kgOf("clothes_year", a) * 0.45),
      }),
    },
  ],
  waste: [
    {
      when: (a) => (a.rubbish_bags_week ?? 0) >= 2,
      build: (a) => ({
        text: "Put food scraps in the food bin, not the black bin. Food buried in the ground rots and gives off a harmful gas.",
        savingKg: roundKg(kgOf("rubbish_bags_week", a) * 0.25),
      }),
    },
    {
      when: (a) => (a.rubbish_bags_week ?? 0) > (a.recycling_bags_week ?? 0),
      build: (a) => ({
        text: "Keep a second box in the kitchen for recycling. Then it never ends up in the rubbish bag by mistake.",
        savingKg: roundKg(kgOf("rubbish_bags_week", a) * 0.2),
      }),
    },
  ],
  lifestyle: [
    {
      when: (a) => (a.hotel_nights_year ?? 0) >= 5,
      build: (a) => ({
        text: "Take a break closer to home. You still get away, without the long journey.",
        savingKg: roundKg(kgOf("hotel_nights_year", a) * 0.3),
      }),
    },
  ],
};

/**
 * The total, turned into something a person can picture.
 *
 * Kilograms of carbon are invisible and weightless to most people; miles in a
 * car are not. The conversion uses the same factor the household was scored
 * on, so the comparison is consistent rather than decorative.
 */
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

/**
 * Picks the suggestions and works out every figure. This always runs — OpenAI
 * only ever rewrites the wording afterwards.
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

  // At most one suggestion per area, so they cover different parts of the week
  // rather than three settings on the same boiler. Within an area, whichever
  // saves most; then ordered by size.
  const candidates: AdviceAction[] = ranked
    .map(
      (category) =>
        (TIPS[category.categoryId] ?? [])
          .filter((tip) => tip.when(answers))
          .map((tip) => tip.build(answers))
          .filter((action): action is AdviceAction => action !== null)
          .sort((a, b) => b.savingKg - a.savingKg)[0],
    )
    .filter((action): action is AdviceAction => action !== undefined)
    .sort((a, b) => b.savingKg - a.savingKg);

  // Two, or three when the third earns its place. Padding to a fixed three
  // means someone reads a trivial suggestion beside a real one and learns to
  // skim both.
  const best = candidates[0]?.savingKg ?? 0;
  const actions = candidates
    .filter(
      (action, index) =>
        index < 2 || action.savingKg >= Math.max(50, best * 0.2),
    )
    .slice(0, 3);

  const nothingToChange = actions.length === 0;

  if (nothingToChange) {
    actions.push({
      text: "There is very little to change here. Your home already uses less than most.",
      savingKg: 0,
    });
    actions.push({
      text: "Keep the heating steady and the bins sorted, and it stays that way.",
      savingKg: 0,
    });
  } else if (actions.length === 1) {
    actions.push({
      text: "Show a neighbour how to do this, and it counts twice.",
      savingKg: 0,
    });
  }

  const biggest = ranked[0];
  const perPerson = Math.round(result.perPersonKg);
  const comparedToTypical =
    perPerson < 5000
      ? "less than"
      : perPerson > 8000
        ? "more than"
        : "about the same as";

  const summary = nothingToChange
    ? `Your home already uses ${comparedToTypical} most homes in the UK, and nothing here stands out as an easy saving.`
    : biggest
      ? `Most of it comes from ${biggest.name.toLowerCase()}. Your home uses ${comparedToTypical} most homes in the UK.`
      : `This is just the food and drink everybody needs. There is nothing else to count.`;

  return {
    summary,
    comparison: buildComparison(result),
    actions,
    source: "built-in",
  };
}

/**
 * Takes the model's rewrite only if it kept the shape: the same number of
 * suggestions, in the same order. Our figures are then reattached, so a
 * rewrite can never change what a household is promised.
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
    `Rewrite these ${base.actions.length} suggestions, in this order, keeping every figure exactly:`,
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
