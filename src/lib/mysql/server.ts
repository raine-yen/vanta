import { cookies } from "next/headers";
import { MySqlClient } from "@/lib/mysql-client";
import { requestContext } from "@/lib/request-context";

export async function mysqlServer(): Promise<MySqlClient> {
  const expressContext = requestContext.getStore();
  if (expressContext) return new MySqlClient({ cookieHeader: expressContext.cookieHeader, setCookie: expressContext.setCookie });
  const store = await cookies();
  return new MySqlClient({
    cookieHeader: store.getAll().map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join("; "),
    setCookie: (value) => {
      try {
        const [pair, ...attributes] = value.split(";").map((part) => part.trim());
        const [name, encoded] = pair.split("=");
        store.set(name, decodeURIComponent(encoded ?? ""), {
          httpOnly: true,
          secure: attributes.some((part) => part.toLowerCase() === "secure"),
          sameSite: "lax",
          path: "/",
          maxAge: Number(attributes.find((part) => /^Max-Age=/i.test(part))?.split("=")[1] ?? 0),
        });
      } catch { /* Server Components cannot write cookies. */ }
    },
  });
}
