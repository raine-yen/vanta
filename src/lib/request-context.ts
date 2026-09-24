import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  cookieHeader: string;
  authorization: string | null;
  setCookie: (cookie: string) => void;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function readCookie(header: string, name: string): string | null {
  const item = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!item) return null;
  try { return decodeURIComponent(item.slice(name.length + 1)); } catch { return null; }
}
