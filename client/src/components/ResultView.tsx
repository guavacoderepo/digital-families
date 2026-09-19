import { GrassField } from "./GrassField";
import { kg, number } from "../lib/format";
import type { Assessment } from "../types";

interface Props {
  assessment: Assessment;
  methodologyNote: string;
  onRestart: () => void;
}

/** Plain words for the state of the lawn. No grades, no percentages. */
function verdict(health: number): { headline: string; caption: string } {
  if (health > 0.78) {
    return {
      headline: "Your grass is thriving",
      caption:
        "You are living lightly. There is very little here that needs changing.",
    };
  }
  if (health > 0.58) {
    return {
      headline: "Your grass is doing well",
      caption:
        "You are below what most homes use. A couple of small changes would help further.",
    };
  }
  if (health > 0.4) {
    return {
      headline: "Your grass is starting to dry out",
      caption:
        "You are around the same as most homes in the UK. There is room to bring this down.",
    };
  }
  if (health > 0.22) {
    return {
      headline: "Your grass is struggling",
      caption:
        "Your home uses more than most. The suggestions below are the ones that matter most.",
    };
  }
  return {
    headline: "Your grass is dying back",
    caption:
      "Your home uses a good deal more than most. Start with the first suggestion below.",
  };
}

export function ResultView({ assessment, methodologyNote, onRestart }: Props) {
  const { headline, caption } = verdict(assessment.health);
  // Every answer left at zero almost always means the questions were skipped,
  // not that somebody lives without heat, food or transport. Saying "you are
  // doing wonderfully" to a page of untouched zeros would be a lie.
  const nothingAnswered = Object.values(assessment.answers).every(
    (value) => !value,
  );
  const ranked = [...assessment.categories]
    .filter((c) => c.kg > 0)
    .sort((a, b) => b.kg - a.kg);
  const biggest = ranked[0]?.kg ?? 1;

  return (
    <div className="result">
      <figure className="result__scene">
        <GrassField health={assessment.health} />
        <figcaption className="result__verdict">
          <h2 className="result__headline">{headline}</h2>
          <p className="result__caption">{caption}</p>
        </figcaption>
      </figure>

      {nothingAnswered && (
        <div className="notice">
          <p>
            <strong>Every question was left at zero.</strong>
          </p>
          <p>
            This figure is only the allowance for everyday food. If you meant to
            fill the questions in, start again and add your own numbers.
          </p>
        </div>
      )}

      <section className="result__figure" aria-label="Your total">
        <p className="result__lead">Your home creates about</p>
        <p className="result__total">
          <span className="result__total-value">
            {number(assessment.totalKg)}
          </span>
          <span className="result__total-unit">kg of carbon a year</span>
        </p>
        <p className="result__lead">
          That is {kg(assessment.perPersonKg)} each. A typical person in the UK
          is around 6,500 kg.
        </p>
        <p className="result__comparison">{assessment.advice.comparison}</p>
      </section>

      <section className="advice" aria-label="What would help most">
        <h3 className="section-title">What would help most</h3>
        <ol className="advice__list">
          {assessment.advice.actions.map((action, index) => (
            <li key={index} className="advice__item">
              <span className="advice__number" aria-hidden="true">
                {index + 1}
              </span>
              <span className="advice__body">
                <span>{action.text}</span>
                {action.savingKg > 0 && (
                  <span className="advice__saving">
                    Saves about {number(action.savingKg)} kg of carbon a year
                    {action.savingPounds
                      ? ` and around £${number(action.savingPounds)} off the bill`
                      : ""}
                    .
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
        <p className="advice__summary">{assessment.advice.summary}</p>
      </section>

      <details className="breakdown">
        <summary className="breakdown__toggle">
          Show where it comes from
        </summary>
        <ul className="breakdown__list">
          {ranked.map((category) => (
            <li className="breakdown__row" key={category.categoryId}>
              <span className="breakdown__name">{category.name}</span>
              <span className="breakdown__track">
                <span
                  className="breakdown__fill"
                  style={{ width: `${(category.kg / biggest) * 100}%` }}
                />
              </span>
              <span className="breakdown__kg">{kg(category.kg)}</span>
            </li>
          ))}
        </ul>
        <p className="breakdown__note">{methodologyNote}</p>
      </details>

      <div className="actions">
        <button type="button" className="btn btn--big" onClick={onRestart}>
          Start again
        </button>
      </div>
    </div>
  );
}
