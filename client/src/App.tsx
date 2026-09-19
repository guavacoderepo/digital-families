import { useState } from "react";
import { AssessmentPage } from "./pages/AssessmentPage";
import { DashboardPage } from "./pages/DashboardPage";

export default function App() {
  const [view, setView] = useState<"questions" | "results">("questions");
  const [savedCount, setSavedCount] = useState(0);

  return (
    <div className="app">
      <header className="masthead">
        <p className="masthead__name">Digital Families Programme</p>
        <nav className="masthead__nav" aria-label="Sections">
          <button
            type="button"
            className="masthead__tab"
            aria-current={view === "questions" ? "page" : undefined}
            onClick={() => setView("questions")}
          >
            Questions
          </button>
          <button
            type="button"
            className="masthead__tab"
            aria-current={view === "results" ? "page" : undefined}
            onClick={() => setView("results")}
          >
            Results
          </button>
        </nav>
      </header>

      {view === "questions" ? (
        <AssessmentPage onSaved={() => setSavedCount((n) => n + 1)} />
      ) : (
        <DashboardPage refreshKey={savedCount} />
      )}
    </div>
  );
}
