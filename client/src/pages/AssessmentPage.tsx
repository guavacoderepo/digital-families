import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { NumberStepper } from "../components/NumberStepper";
import { ResultView } from "../components/ResultView";
import type { Assessment, Schema } from "../types";

/**
 * One area to a screen, with Back and Next. No sidebar, no running total.
 *
 * A live total sounds helpful but it is not: it gives people a number to react
 * to before they have finished, and it invites them to go back and fiddle with
 * answers to improve the score. One thing on screen at a time, then the result.
 */
export function AssessmentPage({ onSaved }: { onSaved: () => void }) {
  const [schema, setSchema] = useState<Schema | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [householdSize, setHouseholdSize] = useState(1);
  const [step, setStep] = useState(0); // 0 = who lives here, then one per area

  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .schema()
      .then((loaded) => {
        if (cancelled) return;
        setSchema(loaded);
        // Everything starts at zero. Nothing is assumed about anybody.
        setAnswers(Object.fromEntries(loaded.questions.map((q) => [q.id, 0])));
      })
      .catch((error: Error) => !cancelled && setLoadError(error.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const totalSteps = (schema?.categories.length ?? 0) + 1;
  const category = schema?.categories[step - 1];

  const questions = useMemo(
    () => schema?.questions.filter((q) => q.categoryId === category?.id) ?? [],
    [schema, category],
  );

  const goTo = useCallback((next: number) => {
    setStep(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const saved = await api.submit(answers, householdSize);
      setAssessment(saved);
      onSaved();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setSubmitError((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [answers, householdSize, onSaved]);

  const restart = useCallback(() => {
    if (!schema) return;
    setAnswers(Object.fromEntries(schema.questions.map((q) => [q.id, 0])));
    setHouseholdSize(1);
    setAssessment(null);
    setSubmitError(null);
    goTo(0);
  }, [schema, goTo]);

  if (loadError) {
    return (
      <main className="page">
        <div className="notice notice--error">
          <p>The questions could not be loaded.</p>
          <p>Please check your connection and reload the page.</p>
        </div>
      </main>
    );
  }

  if (!schema) {
    return (
      <main className="page">
        <p className="loading">Loading…</p>
      </main>
    );
  }

  if (assessment) {
    return (
      <main className="page page--result">
        <ResultView
          assessment={assessment}
          methodologyNote={schema.methodologyNote}
          onRestart={restart}
        />
      </main>
    );
  }

  const isLast = step === totalSteps - 1;

  return (
    <main className="page">
      <div className="progress" aria-hidden="true">
        <div className="progress__bar">
          <div
            className="progress__fill"
            style={{ width: `${((step + 1) / totalSteps) * 100}%` }}
          />
        </div>
        <p className="progress__label">
          Step {step + 1} of {totalSteps}
        </p>
      </div>

      {step === 0 ? (
        <section className="card">
          <h2 className="card__title">First, who lives here?</h2>
          <p className="card__blurb">
            We only need the number of people. We do not ask for names or addresses.
          </p>
          <NumberStepper
            id="household-size"
            label="How many people live in your home?"
            unit={householdSize === 1 ? "person" : "people"}
            value={householdSize}
            step={1}
            max={20}
            onChange={(value) => setHouseholdSize(Math.max(1, value))}
          />
        </section>
      ) : (
        category && (
          <section className="card">
            <h2 className="card__title">{category.name}</h2>
            <p className="card__blurb">{category.blurb}</p>
            {questions.map((question) => (
              <NumberStepper
                key={question.id}
                id={question.id}
                label={question.label}
                unit={question.unit}
                value={answers[question.id] ?? 0}
                step={question.step}
                max={question.max}
                onChange={(value) =>
                  setAnswers((current) => ({ ...current, [question.id]: value }))
                }
              />
            ))}
            <p className="card__hint">
              If something does not apply to you, leave it at zero.
            </p>
          </section>
        )
      )}

      {submitError && (
        <div className="notice notice--error">
          <p>{submitError}</p>
        </div>
      )}

      <nav className="actions" aria-label="Move through the questions">
        {step > 0 && (
          <button
            type="button"
            className="btn btn--big btn--quiet"
            onClick={() => goTo(step - 1)}
          >
            Back
          </button>
        )}
        {isLast ? (
          <button
            type="button"
            className="btn btn--big"
            onClick={() => void submit()}
            disabled={submitting}
          >
            {submitting ? "Working it out…" : "See my result"}
          </button>
        ) : (
          <button type="button" className="btn btn--big" onClick={() => goTo(step + 1)}>
            Next
          </button>
        )}
      </nav>
    </main>
  );
}
