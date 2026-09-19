interface Props {
  id: string;
  label: string;
  unit: string;
  value: number;
  step: number;
  max: number;
  onChange: (value: number) => void;
}

/**
 * Big minus and plus buttons either side of the figure, plus a typable box.
 *
 * A plain number input needs a keyboard, precise tapping on a small spinner,
 * and an understanding that the little arrows are buttons. Two large targets
 * and a visible number need none of that, and the box is still there for
 * anyone who would rather just type 240.
 */
export function NumberStepper({ id, label, unit, value, step, max, onChange }: Props) {
  const clamp = (next: number) => Math.min(max, Math.max(0, next));

  return (
    <div className="question">
      <label className="question__label" htmlFor={id}>
        {label}
      </label>

      <div className="stepper">
        <button
          type="button"
          className="stepper__btn"
          onClick={() => onChange(clamp(value - step))}
          disabled={value <= 0}
          aria-label={`Fewer. ${label}`}
        >
          <span aria-hidden="true">−</span>
        </button>

        <span className="stepper__box">
          <input
            id={id}
            className="stepper__input"
            type="number"
            inputMode="numeric"
            min={0}
            max={max}
            step={step}
            value={value}
            onFocus={(event) => event.target.select()}
            onChange={(event) =>
              onChange(clamp(event.target.value === "" ? 0 : Number(event.target.value)))
            }
          />
          <span className="stepper__unit">{unit}</span>
        </span>

        <button
          type="button"
          className="stepper__btn"
          onClick={() => onChange(clamp(value + step))}
          disabled={value >= max}
          aria-label={`More. ${label}`}
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>
    </div>
  );
}
