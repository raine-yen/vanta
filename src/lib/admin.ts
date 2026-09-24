export function hasAdminRole(role?: string | null) {
  return role === "owner" || role === "manager";
}
