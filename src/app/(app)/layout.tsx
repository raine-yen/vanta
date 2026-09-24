import { redirect } from "next/navigation";
import { mysqlServer } from "@/lib/mysql/server";
import { Nav } from "@/components/nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const sb = await mysqlServer();
  const { data } = await sb.auth.getUser();
  if (!data.user) redirect("/login");

  return (
    <div className="min-h-screen bg-bg lg:flex">
      <Nav email={data.user.email ?? undefined} />
      <main className="vanta-app-main">{children}</main>
    </div>
  );
}
