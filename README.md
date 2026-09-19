# Digital Families Programme — household carbon footprint

A simple tool for older adults. Answer a few plain questions about your home,
and see the carbon it creates in a year — shown as a lawn that is either
thriving or drying out, with three short things that would help.

- **`server/`** — Express + TypeScript, SQLite (better-sqlite3), OpenAI
- **`client/`** — React 18 + TypeScript + Vite, no UI dependencies

---

## Running it

Two terminals. Node 18 or newer.

```bash
# 1. API — http://localhost:3001
cd server
npm install
cp .env.example .env        # OPENAI_API_KEY is optional, see below
npm run dev

# 2. Web — http://localhost:5173
cd client
npm install
npm run dev
```

Vite proxies `/api` to port 3001, so the browser only ever talks to one origin.

**There is no seed data.** The database starts empty and fills only with real
answers from real households. The Results screen says so until the first one
arrives.

### Without an OpenAI key

The app runs fully. The three suggestions come from the rule-based adviser in
`server/src/services/advice.ts` instead of the model. Add `OPENAI_API_KEY` to
`.env` to switch over — no other change needed.

### Building for production

```bash
cd server && npm run build && npm start
cd client && npm run build          # static files land in client/dist
```

---

## Built for the people using it

Most of the decisions here follow from the audience being in their seventies
and eighties, often on a tablet, sometimes with a volunteer beside them.

**Everything starts at zero.** No question is pre-filled with a guess about
somebody's life. If a thing does not apply, it stays at zero and contributes
nothing.

**Nineteen questions, two or three to a screen.** One area at a time, with
Back and Next. There is no sidebar and no running total: a live counter gives
people a number to react to before they have finished, and invites them to go
back and fiddle with answers to improve the score.

**Big plus and minus buttons rather than a text box.** A number field needs a
keyboard, precise tapping on a tiny spinner, and knowing that the little arrows
are buttons. Two 72px targets need none of that. The box is still typable for
anyone who would rather enter 240 directly.

**Units people actually think in** — miles, pounds on the bill, meals, bags.
Asking an eighty-year-old for kilowatt hours gets a guess or a blank. Asking
for the gas bill gets a real number off the fridge door.

**20px body text, 56px minimum on every control, high contrast throughout.** The
page also respects a larger browser font size rather than overriding it.

---

## The result is a lawn

A letter grade means nothing on its own, and nobody in this group is going to
read a chart. Everyone already knows what healthy grass and dying grass look
like, so the picture is understood before a word is read.

A health score from 0 to 1 drives colour, blade height, droop, density, how
much bare earth shows through, and the haze in the sky — several signals at
once, so the difference between a good result and a poor one is obvious from
across a room. The score is a curve pinned so the UK average of about 6.5
tonnes a head lands squarely in the middle; a straight line would leave almost
everybody in the same washed-out state and the picture would stop saying
anything.

Blades are grouped into four depth layers and only the layer sways, not each
blade — four animated nodes instead of six hundred, which keeps it smooth on
old tablets. The whole thing stops under `prefers-reduced-motion`.

Below the lawn: the total in large figures, then three short lines of advice,
then a folded-away breakdown for anyone who wants it.

---

## How the numbers work

The questionnaire is data, not code. Every area, question and emission factor
lives in `server/src/domain/questions.ts` and is served to the browser at
`GET /api/schema`. The client renders whatever it is given, so adding a
question or reweighting a factor needs no front-end change.

Each answer is a count multiplied by a factor. There are no dropdowns and no
questions that adjust other questions — the earlier version had both, and they
cost more in confusion than they bought in accuracy.

**Food carries a baseline of 900 kg per person per year.** Everybody eats, so a
household answering zero to every food question still has a food footprint, and
pretending otherwise would understate the total by a tonne a head. Advice ranks
areas on `kg − baseline`, because telling everyone their biggest area is food
when most of that figure is unavoidable would send them all to the same useless
first line.

**Rating is per person, not per household**, otherwise a large family is
penalised for existing.

| Band | Tonnes each, per year | Shown as |
|------|----------------------|----------|
| A | under 2.0 | Very small |
| B | 2.0 – 3.5 | Small |
| C | 3.5 – 5.0 | Below average |
| D | 5.0 – 7.0 | About average |
| E | 7.0 – 9.5 | Above average |
| F | 9.5 – 13 | Large |
| G | over 13 | Very large |

The letters are for the programme dashboard. The households see the grass and
plain words.

### The three lines

`generateAdvice()` sends the household's own breakdown and answers to OpenAI in
JSON mode and asks for exactly three lines, each under about 20 words, in
everyday language, with "emissions", "carbon footprint", "sustainable" and
"offset" banned outright. Anything unparseable falls through to the built-in
adviser rather than erroring.

The built-in adviser is answer-aware: each tip carries a condition, so it will
not tell someone without a car to drive less, or someone who never flies to fly
less. If a household is already doing everything on the list, it says so
instead of inventing filler.

---

## API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Liveness, and which advice engine is active |
| `GET` | `/api/schema` | Areas, questions, bands |
| `POST` | `/api/assessments` | Calculate, get advice, save, return the result |
| `GET` | `/api/assessments?limit=n` | Recent results |
| `GET` | `/api/assessments/:id` | One result |
| `GET` | `/api/dashboard` | Programme totals |

```json
{
  "household": { "size": 2 },
  "answers": { "car_miles_week": 60, "gas_bill_month": 55 }
}
```

Unknown answer keys are dropped server-side, and anything missing is treated as
zero.

---

## Storage

SQLite at `server/data/dfp.sqlite` (override with `DATABASE_PATH`), created on
first run with WAL enabled.

- **`assessments`** — one row per household, with answers, breakdown and advice
  kept as JSON.
- **`category_totals`** — one row per area per household. Denormalised on
  purpose: it turns "average by area" into a single `GROUP BY` instead of
  parsing JSON for every row.

The only thing recorded about a person is how many people live in their home.
No names, no addresses, no contact details.

---

## Before this goes live

**The emission factors are indicative.** They are defensible for a UK household
and easy to explain, but they are rounded and several bundle a chain of
assumptions into one number — any return flight is 400 kg regardless of where
it went, and the bill-to-carbon conversions assume roughly 28p a unit for
electricity and 7p for gas. Those tariff assumptions in particular go stale
fast. Replace the lot with current DEFRA conversion factors and current prices
before publishing anything. They are all in one file for exactly that reason.

**There is no authentication.** Anyone who can reach `/api/dashboard` sees every
household's result, and anyone can POST one. Fine for a pilot on a laptop in a
church hall; it needs a login before this is on the open internet.

**Somebody should sit with a real user before this ships.** Everything here is
reasoned from what is known about designing for older adults, but reasoning is
not testing. Watch three people in their eighties use it and you will learn
more than another week of building.
