/** Browser data access stays on the same-origin Express /api endpoints. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path.startsWith("/") ? path : `/api/${path}`, { credentials: "same-origin", ...init });
}
