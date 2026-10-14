export function maskDestination(value: string): string {
  if (value.includes("@")) {
    const [local = "", domain = ""] = value.split("@", 2);
    const parts = domain.split(".");
    const host = parts.shift() ?? "";
    const suffix = parts.length > 0 ? `.${parts.join(".")}` : "";
    return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${suffix}`;
  }
  if (value.startsWith("+") && value.length >= 7) return `${value.slice(0, 3)}*****${value.slice(-4)}`;
  return "***";
}
