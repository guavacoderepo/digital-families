import type { Band, Category, Question, Schema } from "./types.js";

/**
 * EMISSION FACTORS
 * ----------------
 * Indicative figures, chosen so a UK household can answer honestly from
 * memory. Several bundle a chain of assumptions into one number — a return
 * flight is treated as one figure regardless of the airport, for example.
 *
 * Units are the ones people actually think in: miles, pounds on the bill,
 * meals, bags. Asking an 80-year-old for kilowatt hours gets you a guess or a
 * blank. Asking for the gas bill gets you a real number off the fridge door.
 *
 * Replace these with the current DEFRA conversion factors before publishing
 * results. They are all in this one file so that is a single-file edit.
 */

/**
 * The price and carbon assumptions behind the bill questions, in one place.
 *
 * Advice reuses these to turn a carbon saving back into pounds off the bill,
 * so the figure a household is shown always matches the figure the same
 * household was scored on. Update the prices here and both move together.
 *
 * The pence figures are EFFECTIVE RATES — they average the standing charge
 * across typical usage so a household can answer from a single line on the
 * bill. They are not the headline unit rate. If you want to use the raw
 * Ofgem price cap unit rate instead, drop to about 26p and 6.5p and adjust
 * the two kgPerUnit calculations below to match.
 */
export const TARIFF = {
  electricityPencePerKwh: 28,
  gasPencePerKwh: 7,
  electricityKgPerKwh: 0.207,
  gasKgPerKwh: 0.183,
  /** kg CO2e for one mile in an average car. */
  carKgPerMile: 0.275,
} as const;

/**
 * Flight factors. Two figures rather than one, because the gap between a
 * domestic hop and a long-haul return is large enough to change a household's
 * band. Both are per return journey, per person.
 *
 * Short-haul is a return within Europe, around 1,500 miles total, roughly
 * 0.18 kg CO2e per passenger-km including the radiative forcing multiplier
 * that aviation is usually quoted with.
 *
 * Long-haul is a return beyond Europe, around 7,000 miles total, same
 * multiplier.
 */
export const FLIGHT_KG = {
  shortHaulReturn: 500,
  longHaulReturn: 2200,
} as const;

export const categories: Category[] = [
  {
    id: "transport",
    name: "Getting about",
    blurb: "Car journeys, buses, trains and any flights.",
  },
  {
    id: "home",
    name: "Heating and power",
    blurb: "What it costs to keep your home warm and lit.",
  },
  {
    id: "food",
    name: "Food",
    blurb: "What you eat in a normal week.",
    // Everybody eats. A household answering zero to every question here still
    // has a food footprint, and pretending otherwise would understate the
    // total by a tonne a head.
    baselinePerPerson: 900,
    baselineLabel: "Everyday food and drink",
  },
  {
    id: "water",
    name: "Hot water",
    blurb: "Washing yourself and your clothes.",
  },
  {
    id: "shopping",
    name: "Shopping",
    blurb: "Clothes and anything electrical.",
  },
  {
    id: "digital",
    name: "Television and devices",
    blurb: "Watching online, and things left switched on.",
  },
  {
    id: "waste",
    name: "Bins",
    blurb: "What you put out each week.",
  },
  {
    id: "lifestyle",
    name: "Away days and pets",
    blurb: "Nights away from home, and animals in the house.",
  },
];

export const questions: Question[] = [
  // Getting about
  {
    id: "car_miles_week",
    categoryId: "transport",
    label: "How many miles do you travel by car in a week?",
    unit: "miles",
    step: 10,
    max: 1000,
    kgPerUnit: TARIFF.carKgPerMile * 52,
  },
  {
    id: "bus_train_week",
    categoryId: "transport",
    label: "How many bus or train journeys do you make in a week?",
    unit: "journeys",
    step: 1,
    max: 100,
    kgPerUnit: 0.8 * 52,
  },
  {
    id: "flights_short_year",
    categoryId: "transport",
    label: "How many return flights within Europe do you take in a year?",
    unit: "flights",
    step: 1,
    max: 30,
    kgPerUnit: FLIGHT_KG.shortHaulReturn,
  },
  {
    id: "flights_long_year",
    categoryId: "transport",
    label:
      "How many return flights further afield, such as to America or Asia, do you take in a year?",
    unit: "flights",
    step: 1,
    max: 10,
    kgPerUnit: FLIGHT_KG.longHaulReturn,
  },

  // Heating and power
  {
    id: "electricity_bill_month",
    categoryId: "home",
    label: "What is your electricity bill each month?",
    unit: "pounds",
    step: 5,
    max: 800,
    // About 28p effective a unit, and about 0.207 kg for each unit, over
    // twelve months.
    kgPerUnit:
      (100 / TARIFF.electricityPencePerKwh) * TARIFF.electricityKgPerKwh * 12,
  },
  {
    id: "gas_bill_month",
    categoryId: "home",
    label: "What is your gas bill each month?",
    unit: "pounds",
    step: 5,
    max: 800,
    // About 7p effective a unit, and about 0.183 kg for each unit, over
    // twelve months.
    kgPerUnit: (100 / TARIFF.gasPencePerKwh) * TARIFF.gasKgPerKwh * 12,
  },
  {
    id: "heating_oil_year",
    categoryId: "home",
    label: "How much heating oil do you buy in a year?",
    unit: "litres",
    step: 100,
    max: 6000,
    kgPerUnit: 2.54,
  },

  // Food
  {
    id: "red_meat_meals_week",
    categoryId: "food",
    label:
      "How many meals with beef, lamb or pork does your home eat in a week?",
    unit: "meals",
    step: 1,
    max: 60,
    // A meal's worth of red meat is roughly 4.5 kg CO2e. The range across
    // portion sizes and cuts is wide, from about 2 kg for a small portion of
    // pork to about 7.5 kg for a beef steak. 4.5 is the middle, chosen so a
    // household eating red meat every day is not over-scored.
    kgPerUnit: 4.5 * 52,
  },
  {
    id: "other_meat_meals_week",
    categoryId: "food",
    label: "How many meals with chicken or fish does your home eat in a week?",
    unit: "meals",
    step: 1,
    max: 60,
    kgPerUnit: 1.5 * 52,
  },
  {
    id: "meals_out_week",
    categoryId: "food",
    label: "How many takeaways or meals out does your home have in a week?",
    unit: "meals",
    step: 1,
    max: 40,
    kgPerUnit: 3.2 * 52,
  },

  // Hot water
  {
    id: "showers_week",
    categoryId: "water",
    label: "How many showers or baths are taken in your home in a week?",
    unit: "showers",
    step: 1,
    max: 100,
    kgPerUnit: 0.7 * 52,
  },
  {
    id: "washing_loads_week",
    categoryId: "water",
    label: "How many washing machine loads do you run in a week?",
    unit: "loads",
    step: 1,
    max: 40,
    kgPerUnit: 0.6 * 52,
  },

  // Shopping
  {
    id: "clothes_year",
    categoryId: "shopping",
    label: "How many new items of clothing does your home buy in a year?",
    unit: "items",
    step: 1,
    max: 300,
    kgPerUnit: 15,
  },
  {
    id: "devices_year",
    categoryId: "shopping",
    label: "How many new phones, tablets or computers do you buy in a year?",
    unit: "devices",
    step: 1,
    max: 30,
    kgPerUnit: 180,
  },

  // Television and devices
  {
    id: "streaming_hours_week",
    categoryId: "digital",
    label: "How many hours do you watch television online in a week?",
    unit: "hours",
    step: 1,
    max: 120,
    kgPerUnit: 0.055 * 52,
  },
  {
    id: "always_on_devices",
    categoryId: "digital",
    label: "How many things are left switched on all the time?",
    unit: "things",
    step: 1,
    max: 30,
    kgPerUnit: 15,
  },

  // Bins
  {
    id: "rubbish_bags_week",
    categoryId: "waste",
    label: "How many bags of rubbish do you put out in a week?",
    unit: "bags",
    step: 1,
    max: 20,
    kgPerUnit: 3.6 * 52,
  },
  {
    id: "recycling_bags_week",
    categoryId: "waste",
    label: "How many bags or boxes do you put out for recycling in a week?",
    unit: "bags",
    step: 1,
    max: 20,
    kgPerUnit: 0.2 * 52,
  },

  // Away days and pets
  {
    id: "hotel_nights_year",
    categoryId: "lifestyle",
    label: "How many nights a year do you spend away from home?",
    unit: "nights",
    step: 1,
    max: 200,
    kgPerUnit: 15,
  },
  {
    id: "pets",
    categoryId: "lifestyle",
    label: "How many cats or dogs live in your home?",
    unit: "pets",
    step: 1,
    max: 15,
    // Indicative, based on a medium dog's food footprint. The range across
    // a small cat and a large dog is wide, from roughly 150 kg to 800 kg.
    // 300 is the middle, chosen so a two-pet household is not over-scored.
    kgPerUnit: 300,
  },
];

/**
 * Tonnes CO2e per person per year. The letters are kept for the programme
 * dashboard; the people answering the questions see the words and the grass.
 */
export const bands: Band[] = [
  {
    letter: "A",
    label: "Very small",
    minTonnes: 0,
    maxTonnes: 2,
    color: "#1B6B3A",
  },
  {
    letter: "B",
    label: "Small",
    minTonnes: 2,
    maxTonnes: 3.5,
    color: "#3E9B4F",
  },
  {
    letter: "C",
    label: "Below average",
    minTonnes: 3.5,
    maxTonnes: 5,
    color: "#8CBF3F",
  },
  {
    letter: "D",
    label: "About average",
    minTonnes: 5,
    maxTonnes: 7,
    color: "#E8B62C",
  },
  {
    letter: "E",
    label: "Above average",
    minTonnes: 7,
    maxTonnes: 9.5,
    color: "#E08A2B",
  },
  {
    letter: "F",
    label: "Large",
    minTonnes: 9.5,
    maxTonnes: 13,
    color: "#D2622C",
  },
  {
    letter: "G",
    label: "Very large",
    minTonnes: 13,
    maxTonnes: Infinity,
    color: "#B8352F",
  },
];

export const methodologyNote =
  "These figures are a good guide, not an exact measurement. They cover the " +
  "things a household can change, and include an allowance for everyday food. " +
  "Flights are the biggest single uncertainty: a return within Europe and a " +
  "return to America are counted separately, but the distance to each " +
  "destination varies and two people on the same route may see different " +
  "figures from their airline.";

export const schema: Schema = {
  categories,
  questions,
  // Infinity is not valid JSON, so the top band is capped for the wire.
  bands: bands.map((b) => ({
    ...b,
    maxTonnes: Number.isFinite(b.maxTonnes) ? b.maxTonnes : 25,
  })),
  methodologyNote,
};

export const questionsById = new Map(questions.map((q) => [q.id, q]));
export const categoriesById = new Map(categories.map((c) => [c.id, c]));
