const whole = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

/** 4,200 — always a whole number. Decimals invite questions we cannot answer. */
export function number(value: number): string {
  return whole.format(Math.round(value));
}

export function kg(value: number): string {
  return `${number(value)} kg`;
}

export function fullDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
