import OpenAI from "openai";
import { TARIFF, categoriesById, questionsById } from "../domain/questions.js";
import type {
  Advice,
  AdviceAction,
  FootprintResult,
  Household,
} from "../domain/types.js";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

/**
 * Printed at boot. If the number in your terminal is not the number you were
 * sent, the server is loading a different copy of this file — which is worth
 * knowing before you spend an evening debugging behaviour that was fixed days
 * ago.
 */
const BUILD = "2026-09-19-e";

/** How many suggestions a household is shown. */
const WANTED = 4;

/** Set ADVICE_DEBUG=1 to dump the whole prompt and the raw reply. */
const DEBUG = process.env.ADVICE_DEBUG === "1";

const rawKey = process.env.OPENAI_API_KEY;
const client = rawKey ? new OpenAI({ apiKey: rawKey }) : null;

const log = (message: string) => console.log(`[advice] ${message}`);
const warn = (message: string) => console.warn(`[advice] ${message}`);

/**
 * Said once at boot. Catches the two mistakes that cost the most time: a key
 * wrapped in quotes in .env, and a key with a trailing space or newline. Both
 * look right in the file and both are rejected with a 401.
 */
(function checkKey() {
  log(`advice build ${BUILD} · ${WANTED} suggestions per household`);
  if (!rawKey) {
    log(`no OPENAI_API_KEY — the built-in wording will be used for everything`);
    return;
  }

  const key = rawKey.trim();

  if (rawKey !== key) {
    warn(
      `OPENAI_API_KEY has a space or newline around it — that will be rejected`,
    );
  }
  if (/^["']|["']$/.test(rawKey)) {
    warn(
      `OPENAI_API_KEY is wrapped in quotes — remove them, .env does not need them`,
    );
  }

  if (!key.startsWith("sk-")) {
    // An OpenAI key always begins "sk-". Name the usual culprits rather than
    // just saying it is wrong, because the value is secret and cannot be shown.
    warn(`OPENAI_API_KEY does not start with "sk-", so OpenAI will reject it`);

    if (/^Bearer\s/i.test(key)) {
      warn(
        `  → it starts with "Bearer ". Paste only the key itself, without that word.`,
      );
    } else if (/^OPENAI_API_KEY\s*=/i.test(key)) {
      warn(
        `  → the whole line was pasted as the value. Keep only what follows the first "=".`,
      );
    } else if (key.includes(" ")) {
      warn(
        `  → there is a space inside it, so something extra was copied with it.`,
      );
    } else if (/^AIza/.test(key)) {
      warn(`  → that looks like a Google AI key, not an OpenAI one.`);
    } else if (/^(sk_|pk_|xai-|gsk_|hf_)/.test(key)) {
      warn(`  → that looks like a key for a different service.`);
    } else {
      warn(
        `  → check you copied the whole key from platform.openai.com/api-keys.`,
      );
    }

    // The quiet one. dotenv does NOT overwrite a variable the shell already
    // set, so an old key in .bashrc silently beats the .env file every time.
    warn(
      `  → if .env looks right, the shell may be overriding it. Run: echo \${#OPENAI_API_KEY}`,
    );
    warn(
      `     If that prints a number, run: unset OPENAI_API_KEY   then start again.`,
    );
  }

  log(
    `key loaded (${key.length} characters, starts "${key.slice(0, 3)}"), model ${MODEL}`,
  );
})();

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
 */

const SYSTEM_PROMPT = `You write the closing advice for the Digital Families Programme, a
community scheme that helps households work out the carbon their home creates.

Who is reading: mostly women running a household. Many left school at sixteen or
earlier. Many are watching every pound. They are not stupid and they will know at
once if you talk down to them.

Shape of each suggestion — this matters most:
- Two sentences. First what to do. Then why it is worth doing.
- The second sentence is the reason, and it is the half that persuades anybody.
  NEVER drop it. A suggestion that comes back as one sentence is wrong.
- The limit is per sentence, not per suggestion: ten to fifteen words each,
  never more than twenty.

Plain English, and mean it:
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

NUMBERS: keep every figure that appears inside a suggestion — a number of weeks, a
number of pounds — exactly as it is. Never change one, never round one, never add one
of your own.

NEVER write a kilogram figure into a line. The saving in kilograms is already printed
underneath each suggestion on the page, so writing it again shows it twice.

You are given a numbered list of suggestions that already fit this household. Say each
one again in your own words, in the same order. Keep both sentences, keep the meaning,
keep every figure — but do not hand the same wording back. Where you can, tie it to
something this household actually told us. Never shorten a suggestion by deleting its
reason.

Return ONLY a JSON object, no markdown fences:
{
  "summary": "one sentence, under 25 words, saying where most of it comes from",
  "actions": ["first suggestion rewritten", "second rewritten", "..."]
}

"actions" must hold exactly as many items as the numbered list you were given. No more,
no fewer, and never one of your own invention.`;

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
      when: (a) => (a.gas_bill_month ?? 0) + (a.heating_oil_year ?? 0) > 0,
      build: (a) => {
        // Cheap, and the only heating fix that does not need a tradesman.
        const heatingKg =
          kgOf("gas_bill_month", a) + kgOf("heating_oil_year", a);
        return {
          text: "Block the draughts round the doors and the letterbox. A few pounds of foam strip stops heat you have paid for going straight out.",
          savingKg: roundKg(heatingKg * 0.05),
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
  log(
    `household of ${household.size} · ${result.totalKg} kg total · ` +
      `${result.perPersonKg} kg each · band ${result.band.letter}`,
  );

  // Rank on the part they can change. Food carries an allowance for simply
  // eating, and leading with that would send everyone to the same useless
  // first line.
  const changeable = (c: (typeof result.categories)[number]) =>
    c.kg - c.baselineKg;
  const ranked = [...result.categories]
    .filter((c) => changeable(c) > 0)
    .sort((a, b) => changeable(b) - changeable(a));

  log(
    `areas they can change: ${
      ranked
        .map((c) => `${c.categoryId}(${Math.round(changeable(c))}kg)`)
        .join(" ") || "none"
    }`,
  );

  // Every tip that fits, grouped by area, best first within each.
  const byArea = ranked.map((category) => ({
    categoryId: category.categoryId,
    matches: (TIPS[category.categoryId] ?? [])
      .filter((tip) => tip.when(answers))
      .map((tip) => tip.build(answers))
      .filter((action): action is AdviceAction => action !== null)
      .sort((a, b) => b.savingKg - a.savingKg),
  }));

  const matchedCount = byArea.reduce(
    (sum, area) => sum + area.matches.length,
    0,
  );
  log(
    `tips that fit: ${matchedCount} — ${
      byArea
        .filter((area) => area.matches.length > 0)
        .map((area) => `${area.categoryId}×${area.matches.length}`)
        .join(" ") || "none"
    }`,
  );

  // One from each area first, so the four cover four different parts of the
  // week rather than four settings on the same boiler. Only if that leaves us
  // short do we go back for a second tip from an area already used.
  const firstPick = byArea
    .map((area) => area.matches[0])
    .filter((action): action is AdviceAction => action !== undefined)
    .sort((a, b) => b.savingKg - a.savingKg);

  const secondPick = byArea
    .flatMap((area) => area.matches.slice(1))
    .sort((a, b) => b.savingKg - a.savingKg);

  const actions = [...firstPick, ...secondPick].slice(0, WANTED);

  if (actions.length < WANTED) {
    log(`only ${actions.length} real suggestions fit; topping up to ${WANTED}`);
  }

  // Filler, only ever to reach the wanted count. These carry no figure, so
  // nobody is shown a saving we cannot stand behind.
  const fillers: AdviceAction[] = [
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
  for (const filler of fillers) {
    if (actions.length >= WANTED) break;
    actions.push(filler);
  }

  const nothingReal = firstPick.length === 0 && secondPick.length === 0;
  const biggest = ranked[0];
  const perPerson = Math.round(result.perPersonKg);
  const comparedToTypical =
    perPerson < 5000
      ? "less than"
      : perPerson > 8000
        ? "more than"
        : "about the same as";

  const summary = nothingReal
    ? `Your home already uses ${comparedToTypical} most homes in the UK, and nothing here stands out as an easy saving.`
    : biggest
      ? `Most of it comes from ${biggest.name.toLowerCase()}. Your home uses ${comparedToTypical} most homes in the UK.`
      : `This is just the food and drink everybody needs. There is nothing else to count.`;

  log(`chose ${actions.length} suggestions`);

  return {
    summary,
    comparison: buildComparison(result),
    actions,
    source: "built-in",
  };
}

/**
 * Takes what the model sent back, line by line. A wrong count is not a reason
 * to bin the lines it did write: they are merged in order, ours fill any gap,
 * extras are dropped. Our figures are reattached either way, so a rewrite can
 * never change what a household is promised.
 */
function applyRewrite(raw: unknown, base: Advice): Advice | null {
  if (typeof raw !== "object" || raw === null) {
    warn(
      `rewrite rejected: the reply was ${raw === null ? "null" : typeof raw}, not an object`,
    );
    return null;
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.summary !== "string") {
    warn(
      `rewrite rejected: no "summary" string in the reply (keys: ${Object.keys(obj).join(", ")})`,
    );
    return null;
  }
  if (!Array.isArray(obj.actions)) {
    warn(
      `rewrite rejected: "actions" was ${typeof obj.actions}, not an array (keys: ${Object.keys(obj).join(", ")})`,
    );
    return null;
  }

  const rewritten = obj.actions.map((line) =>
    typeof line === "string" && line.trim().length > 0 ? line.trim() : null,
  );

  if (rewritten.length !== base.actions.length) {
    warn(
      `the model sent ${rewritten.length} lines but was given ${base.actions.length}; merging in order`,
    );
  }

  // A trailing "(saves about 90 kg a year)" is the page's job, not the line's.
  // The prompt asks the model not to write one; this makes sure of it.
  const stripSaving = (text: string) =>
    text
      .replace(/[\s(]*\(?\s*saves?\s+(about\s+)?[\d,.]+\s*kg[^)]*\)?\s*$/i, "")
      .trim();

  const actions = base.actions.map((action, index) => ({
    ...action,
    text: rewritten[index] ? stripSaving(rewritten[index]!) : action.text,
  }));

  const changed = actions.filter(
    (action, index) => action.text !== base.actions[index]!.text,
  ).length;

  const allEmpty = rewritten.every((line) => line === null);
  if (allEmpty) {
    warn(`rewrite rejected: every line came back empty`);
    return null;
  }

  if (changed === 0) {
    // It answered, it just agreed with us. That is a success, not a failure.
    log(`the model returned the same wording it was given`);
  } else {
    log(`the model rewrote ${changed} of ${base.actions.length} lines`);
  }
  log(`first line back: "${actions[0]?.text.slice(0, 90) ?? ""}…"`);

  const gutted = actions.filter(
    (action, index) =>
      action.text.length < base.actions[index]!.text.length * 0.6,
  ).length;
  if (gutted > 0) {
    warn(
      `${gutted} of ${base.actions.length} lines came back much shorter than sent — ` +
        `the model has probably dropped the reason from them`,
    );
  }

  return {
    summary: obj.summary.trim(),
    comparison: base.comparison,
    actions,
    source: "openai",
    model: MODEL,
  };
}

/** Turn an OpenAI failure into something you can act on. */
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
      ? `the key in OPENAI_API_KEY was rejected — check it is current, complete, and has no quotes or spaces around it`
      : status === 403
        ? `this key is not allowed to use ${MODEL}`
        : status === 404
          ? `no model called "${MODEL}" is available on this account — check OPENAI_MODEL`
          : status === 429
            ? `rate limited, or the account has run out of credit — check billing at platform.openai.com`
            : status !== undefined && status >= 500
              ? `OpenAI had a server problem; worth trying again`
              : /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(
                    message,
                  )
                ? `could not reach api.openai.com — check the connection, a firewall, or a proxy`
                : error instanceof SyntaxError
                  ? `the reply was not valid JSON`
                  : `see the message above`;

  return `${status ?? "no HTTP status"}${e?.code ? ` ${e.code}` : ""}: ${message}\n[advice]   → ${hint}`;
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
    lines.push(`${index + 1}. ${action.text}`);
    if (action.savingKg > 0) {
      lines.push(
        `   (context only, never write this into the line: about ${action.savingKg} kg a year)`,
      );
    }
  });
  lines.push("");
  lines.push(
    `Return exactly ${base.actions.length} items in "actions". Not more, not fewer.`,
  );

  return lines.join("\n");
}

export async function generateAdvice(
  result: FootprintResult,
  household: Household,
  answers: Record<string, number>,
): Promise<Advice> {
  const base = builtInAdvice(result, household, answers);

  if (!client) {
    log(`done · source=built-in (no OPENAI_API_KEY set)`);
    return base;
  }

  const prompt = buildUserPrompt(result, household, answers, base);
  if (DEBUG) {
    console.log(
      `[advice] --- prompt sent ---\n${prompt}\n[advice] --- end ---`,
    );
  }

  const startedAt = Date.now();
  try {
    log(`asking ${MODEL} to rewrite ${base.actions.length} lines`);

    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.5,
      max_tokens: 700,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    });

    const elapsed = Date.now() - startedAt;
    const choice = completion.choices[0];
    const text = choice?.message?.content ?? "";

    log(
      `replied in ${elapsed} ms · ${text.length} characters · ` +
        `finish_reason=${choice?.finish_reason ?? "none"} · ` +
        `tokens=${completion.usage?.total_tokens ?? "?"}`,
    );

    if (choice?.finish_reason === "length") {
      warn(
        `the reply was cut off by max_tokens — raise it if this keeps happening`,
      );
    }
    if (text.trim().length === 0) {
      warn(`rewrite rejected: the reply was empty`);
      log(`done · source=built-in`);
      return base;
    }
    if (DEBUG) {
      console.log(`[advice] --- raw reply ---\n${text}\n[advice] --- end ---`);
    }

    const cleaned = text
      .replace(/^```(?:json)?/m, "")
      .replace(/```$/m, "")
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseError) {
      warn(
        `rewrite rejected: the reply was not valid JSON — ${(parseError as Error).message}`,
      );
      warn(`first 200 characters were: ${cleaned.slice(0, 200)}`);
      log(`done · source=built-in`);
      return base;
    }

    const rewritten = applyRewrite(parsed, base);
    log(`done · source=${rewritten ? "openai" : "built-in"}`);
    return rewritten ?? base;
  } catch (error) {
    console.error(
      `[advice] the call to OpenAI FAILED after ${Date.now() - startedAt} ms\n` +
        `[advice]   ${describeFailure(error)}`,
    );
    log(`done · source=built-in`);
    return base;
  }
}

export const openAiConfigured = client !== null;
export const knownCategoryIds = [...categoriesById.keys()];
