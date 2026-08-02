import { cookies } from "next/headers";

const COOKIE_NAME = "mlb_admin";

export async function isAdminAuthenticated() {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  const expected = process.env.ADMIN_PASSWORD;
  return Boolean(expected) && token === expected;
}
