import { useEffect, useState } from "react";
import { api } from "../api";
import { fullDate, kg, number } from "../lib/format";
import type { Assessment, DashboardData } from "../types";

/**
 * For the programme coordinator, not for the families. Real data only — there
 * is no seeding, so this is empty until somebody completes the questions.
 */
export function DashboardPage({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [recent, setRecent] = useState<Assessment[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.dashboard(), api.recent(12)])
      .then(([metrics, latest]) => {
        if (cancelled) return;
        setData(metrics);
        setRecent(latest);
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (error) {
    return (
      <main className="page">
        <div className="notice notice--error">
          <p>The dashboard could not load. Please reload the page.</p>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="page">
        <p className="loading">Loading…</p>
      </main>
    );
  }

  if (data.totalAssessments === 0) {
    return (
      <main className="page">
        <h2 className="card__title">Results</h2>
        <div className="card">
          <p className="card__blurb">
            Nothing here yet. Results appear as soon as the first household
            finishes the questions.
          </p>
        </div>
      </main>
    );
  }

  const bandColour = new Map(data.bands.map((b) => [b.letter, b.color]));
  const bandLabel = new Map(data.bands.map((b) => [b.letter, b.label]));
  const categoryName = new Map(data.categories.map((c) => [c.id, c.name]));
  const bandTotal = data.bandCounts.reduce((sum, b) => sum + b.count, 0) || 1;
  const largest = Math.max(...data.categoryAverages.map((c) => c.averageKg), 1);

  return (
    <main className="page">
      <h2 className="card__title">Results</h2>

      <div className="stats">
        <div className="stat">
          <span className="stat__label">Households</span>
          <span className="stat__value">{data.totalAssessments}</span>
        </div>
        <div className="stat">
          <span className="stat__label">People</span>
          <span className="stat__value">{data.peopleReached}</span>
        </div>
        <div className="stat">
          <span className="stat__label">Average each</span>
          <span className="stat__value">{number(data.averagePerPersonKg)}</span>
          <span className="stat__note">kg of carbon a year</span>
        </div>
        <div className="stat">
          <span className="stat__label">Middle figure</span>
          <span className="stat__value">{number(data.medianPerPersonKg)}</span>
          <span className="stat__note">kg of carbon a year</span>
        </div>
      </div>

      <section className="card">
        <h3 className="section-title">How households compare</h3>
        <div className="bandbar">
          {data.bandCounts.map((entry) => (
            <span
              key={entry.band}
              className="bandbar__seg"
              style={{
                width: `${(entry.count / bandTotal) * 100}%`,
                background: bandColour.get(entry.band) ?? "#7C8C87",
              }}
              title={`${bandLabel.get(entry.band)}: ${entry.count}`}
            />
          ))}
        </div>
        <ul className="bandkey">
          {data.bandCounts.map((entry) => (
            <li key={entry.band}>
              <span className="swatch" style={{ background: bandColour.get(entry.band) }} />
              {bandLabel.get(entry.band)} — {entry.count}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h3 className="section-title">Average by area</h3>
        <ul className="breakdown__list">
          {data.categoryAverages.map((entry) => (
            <li className="breakdown__row" key={entry.categoryId}>
              <span className="breakdown__name">
                {categoryName.get(entry.categoryId) ?? entry.categoryId}
              </span>
              <span className="breakdown__track">
                <span
                  className="breakdown__fill"
                  style={{ width: `${Math.max((entry.averageKg / largest) * 100, 0)}%` }}
                />
              </span>
              <span className="breakdown__kg">{kg(entry.averageKg)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h3 className="section-title">Latest</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>People</th>
              <th>Each</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((item) => (
              <tr key={item.id}>
                <td>{fullDate(item.createdAt)}</td>
                <td>{item.household.size}</td>
                <td>{kg(item.perPersonKg)}</td>
                <td>{kg(item.totalKg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
