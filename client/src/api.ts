import type { Assessment, DashboardData, Schema } from "./types";

const BASE = import.meta.env.VITE_API_BASE ?? "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });

  if (!response.ok) {
    let message = "Something went wrong. Please try again.";
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Body was not JSON. The friendly message above is the best we have.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export const api = {
  schema: () => request<Schema>("/schema"),

  submit: (answers: Record<string, number>, size: number) =>
    request<Assessment>("/assessments", {
      method: "POST",
      body: JSON.stringify({ answers, household: { size } }),
    }),

  dashboard: () => request<DashboardData>("/dashboard"),

  recent: (limit = 12) => request<Assessment[]>(`/assessments?limit=${limit}`),
};
