import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="login-shell">
      <section className="login-card">
        <p className="eyebrow">Store team</p>
        <h1>Support inbox</h1>
        <p>Use the staff token issued by the store administrator.</p>
        <LoginForm />
      </section>
    </main>
  );
}
