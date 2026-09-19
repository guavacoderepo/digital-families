import OpenAI from "openai";
import { categoriesById, questionsById } from "../domain/questions.js";
import type { Advice, FootprintResult, Household } from "../domain/types.js";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/**
 * The people reading this are older adults, often on a tablet, sometimes with
 * a volunteer beside them. Three short lines is the whole output. A wall of
 * text gets skipped, and a skipped recommendation changes nothing.
 */
const SYSTEM_PROMPT = `You advise older adults on the Digital Families Programme about
their household carbon footprint. Many are in their seventies and eighties.

How to write:
- Very short sentences. Aim for 15 words a line, never more than 25.
- Everyday words only. Never write "emissions", "carbon footprint", "sustainable",
  "reduce", "offset" or "CO2". Say "carbon" if you must name it at all.
- Warm and matter of fact. No praise, no scolding, no exclamation marks.
- Suggest only what a retired person can actually do. Never suggest buying a heat
  pump, an electric car, or solar panels.
- Base every line on the household's own numbers, which are given to you.
- Never invent grants, prices or scheme names.
- Never mention an area where their figure is already zero or very small.

Return ONLY a JSON object, no markdown fences:
{
  "summary": "one sentence, under 20 words, saying where most of it comes from",
  "lines": ["first suggestion", "second suggestion", "third suggestion"]
}
Exactly three lines. Put the one that saves most first.`;

function buildUserPrompt(
  result: FootprintResult,
  household: Household,
  answers: Record<string, number>,
): string {
  const lines: string[] = [];

  lines.push(
    `${household.size} ${household.size === 1 ? "person lives" : "people live"} in this home.`,
  );
  lines.push(`Their total is ${result.totalKg} kg of carbon a year.`);
  lines.push(`That is ${result.perPersonKg} kg each. A typical UK person is about 6500 kg.`);
  lines.push("");
  lines.push("Where it comes from, biggest first:");

  for (const category of [...result.categories].sort((a, b) => b.kg - a.kg)) {
    if (category.kg === 0) continue;
    const note =
      category.baselineKg > 0
        ? ` — of which ${category.baselineKg} kg is a fixed allowance nobody can avoid, so do not suggest changing that part`
        : "";
    lines.push(
      `- ${category.name}: ${category.kg} kg (${Math.round(category.share * 100)}%)${note}`,
    );
  }

  lines.push("");
  lines.push("What they told us:");
  for (const [id, value] of Object.entries(answers)) {
    const question = questionsById.get(id);
    if (!question || !value) continue;
    lines.push(`- ${question.label} ${value} ${question.unit}`);
  }

  lines.push("");
  lines.push("Anything not listed above is zero. Do not suggest changing it.");

  return lines.join("\n");
}

function coerceAdvice(raw: unknown): Advice | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.summary !== "string" || !Array.isArray(obj.lines)) return null;

  const lines = obj.lines
    .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
    .map((line) => line.trim())
    .slice(0, 3);

  if (lines.length === 0) return null;

  return { summary: obj.summary.trim(), lines, source: "openai", model: MODEL };
}

interface Tip {
  /** Only offer this if the household is actually doing the thing. */
  when: (answers: Record<string, number>) => boolean;
  line: string;
}

const TIPS: Record<string, Tip[]> = {
  transport: [
    {
      when: (a) => (a.flights_year ?? 0) >= 1,
      line: "Taking one return flight fewer a year saves about 400 kg on its own.",
    },
    {
      when: (a) => (a.car_miles_week ?? 0) >= 30,
      line: "Try the bus for one regular trip a week. Short car journeys use the most fuel.",
    },
  ],
  home: [
    {
      when: (a) => (a.gas_bill_month ?? 0) + (a.heating_oil_year ?? 0) > 0,
      line: "Turn the heating down by one degree. Most people never notice, and the bill drops too.",
    },
    {
      when: (a) => (a.electricity_bill_month ?? 0) >= 40,
      line: "Ask your supplier about a green electricity tariff. It usually costs no more.",
    },
  ],
  food: [
    {
      when: (a) => (a.red_meat_meals_week ?? 0) >= 2,
      line: "Swap one beef or lamb dinner a week for chicken, fish or beans.",
    },
    {
      when: (a) => (a.meals_out_week ?? 0) >= 2,
      line: "One fewer takeaway a week adds up over a year.",
    },
  ],
  water: [
    {
      when: (a) => (a.showers_week ?? 0) >= 7,
      line: "Keep showers to about four minutes. Heating the water is the costly part.",
    },
    {
      when: (a) => (a.washing_loads_week ?? 0) >= 3,
      line: "Wash clothes at 30 degrees and wait for a full load.",
    },
  ],
  shopping: [
    {
      when: (a) => (a.devices_year ?? 0) >= 1,
      line: "Keep your phone or tablet a year longer. A new battery costs far less than a new one.",
    },
    {
      when: (a) => (a.clothes_year ?? 0) >= 10,
      line: "Buy a few clothes second hand. Charity shops count.",
    },
  ],
  digital: [
    {
      when: (a) => (a.always_on_devices ?? 0) >= 3,
      line: "Switch off at the wall anything you are not using overnight.",
    },
    {
      when: (a) => (a.streaming_hours_week ?? 0) >= 15,
      line: "Watch on the television rather than streaming on several devices at once.",
    },
  ],
  waste: [
    {
      when: (a) => (a.rubbish_bags_week ?? 0) >= 2,
      line: "Put food scraps in the caddy, not the black bin. Food in landfill is the worst of it.",
    },
    {
      when: (a) => (a.rubbish_bags_week ?? 0) > (a.recycling_bags_week ?? 0),
      line: "Keep a second box in the kitchen so recycling does not end up in the rubbish.",
    },
  ],
  lifestyle: [
    {
      when: (a) => (a.hotel_nights_year ?? 0) >= 5,
      line: "A break closer to home does the same job without the travel.",
    },
  ],
};

/**
 * Rule-based advice. Runs when there is no API key, when OpenAI is
 * unreachable, or when the model returns something unusable. Nobody ever
 * finishes the questions and gets an error instead of an answer.
 */
export function builtInAdvice(
  result: FootprintResult,
  household: Household,
  answers: Record<string, number> = {},
): Advice {
  // Rank on the changeable part. Food carries an unavoidable allowance for
  // simply eating, and leading with that would send everyone to the same
  // useless first line.
  const changeable = (c: (typeof result.categories)[number]) => c.kg - c.baselineKg;
  const ranked = [...result.categories]
    .filter((c) => changeable(c) > 0)
    .sort((a, b) => changeable(b) - changeable(a));

  const lines: string[] = [];
  for (const category of ranked) {
    for (const tip of TIPS[category.categoryId] ?? []) {
      if (lines.length >= 3) break;
      if (tip.when(answers)) lines.push(tip.line);
    }
    if (lines.length >= 3) break;
  }

  if (lines.length === 0) {
    lines.push("There is very little here to change. You are already doing well.");
    lines.push("Keeping the heating steady and the bins sorted holds it where it is.");
    lines.push("Show a neighbour how to do this and you double the good it does.");
  }

  const biggest = ranked[0];
  const perPerson = Math.round(result.perPersonKg);
  const comparison =
    perPerson < 5000 ? "below" : perPerson > 8000 ? "above" : "about the same as";

  const summary = biggest
    ? `Most of your carbon comes from ${biggest.name.toLowerCase()}, and you are ${comparison} the typical UK figure.`
    : `This is only the allowance for everyday food and drink, which everyone has.`;

  return { summary, lines, source: "built-in" };
}

export async function generateAdvice(
  result: FootprintResult,
  household: Household,
  answers: Record<string, number>,
): Promise<Advice> {
  if (!client) return builtInAdvice(result, household, answers);

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.4,
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(result, household, answers) },
      ],
    });

    const text = completion.choices[0]?.message?.content ?? "";
    const cleaned = text.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
    return coerceAdvice(JSON.parse(cleaned)) ?? builtInAdvice(result, household, answers);
  } catch (error) {
    console.error("[advice] OpenAI call failed, using built-in advice:", error);
    return builtInAdvice(result, household, answers);
  }
}

export const openAiConfigured = client !== null;
export const knownCategoryIds = [...categoriesById.keys()];
