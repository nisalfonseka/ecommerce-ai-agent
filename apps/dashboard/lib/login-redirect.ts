import { redirect } from "next/navigation";

export function goToLogin(): never {
  redirect("/login");
}
