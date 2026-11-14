// Destination: apps/api/src/lib/placeholders.ts
//
// Fills {{name}} placeholders in a canned or free-form message. Names are
// case-insensitive and may have spaces inside the braces: {{ Contact_Name }}.
// An unknown placeholder is left exactly as written, so a typo shows up in
// the preview instead of silently disappearing. Kept in step with the copy
// in apps/web/src/pages/benefits-administration/CarrierCommunication.tsx.
export const PLACEHOLDERS = ['contact_name', 'carrier_name', 'group_name', 'sender_name', 'sender_email', 'today'] as const;

export function renderPlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key: string) => {
    const k = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : whole;
  });
}
