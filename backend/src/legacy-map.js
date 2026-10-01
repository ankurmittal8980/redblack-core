import { normalizeEmail, normalizePhone } from './validation.js';

export const LEGACY_LEAD_HEADERS = Object.freeze([
  'Lead ID', 'Date Added', 'Name', 'Phone', 'Investor Email', 'Lead Source', 'Budget', 'Timeline',
  'Decision Maker', 'Intent', 'Fit', 'Score', 'Temperature', 'Status', 'Nurture Type',
  'Last Contacted', 'Next Follow-up', 'Next Action', 'Meeting Date', 'Meeting Status', 'Last Outcome',
  'Notes', 'WhatsApp Status', 'Send WhatsApp', 'DND', 'Touch #', 'Last Message Sent', 'Owner',
  'Budget Score', 'Calendar Event ID', 'Brand / Project Name', 'Opportunity Type'
]);

export const LEGACY_STATUS_STAGE = Object.freeze({
  NEW: 'new-lead', 'NEW LEAD': 'new-lead', CONTACTED: 'contact-attempted', 'NO RESPONSE': 'contact-attempted',
  'CALL LATER': 'contact-attempted', HOT: 'qualified', WARM: 'qualified', COLD: 'qualified',
  'NO BUDGET': 'lost', 'PLAN DROPPED': 'lost', 'INVESTED ELSEWHERE': 'lost', 'NOT INTERESTED': 'lost',
  DND: 'lost', LOST: 'lost', WON: 'won', MEETING: 'meeting-presentation', 'POST-MEETING': 'proposal',
  'FUTURE EVENT': 'qualified'
});

export function normalizeLegacyStatus(value) {
  const status = String(value ?? '').trim().toUpperCase();
  return { sourceStatus: status, stageSlug: LEGACY_STATUS_STAGE[status] ?? 'new-lead' };
}

export function parseLegacyDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial >= 1 && serial <= 100000) return new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString();
  }
  const dmy = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dmy) {
    const [, day, month, year, hour = '0', minute = '0', second = '0'] = dmy;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
    if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
    return date.toISOString();
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function parseLegacyBudget(value) {
  const text = String(value ?? '').trim().replace(/[₹,\s]/g, '').toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)(l|lakh|lakhs|cr|crore|crores)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = ['l','lakh','lakhs'].includes(match[2]) ? 100000 : ['cr','crore','crores'].includes(match[2]) ? 10000000 : 1;
  const normalized = amount * multiplier;
  return Number.isFinite(normalized) && normalized <= 1e18 ? String(normalized) : null;
}

export function normalizeLegacyPhone(value, countryCallingCode = '91') {
  if (!value) return null;
  const text = String(value).trim();
  const digits = text.replace(/\D/g, '');
  if (text.startsWith('+')) return normalizePhone(`+${digits}`);
  if (digits.length === 10) return normalizePhone(`+${countryCallingCode}${digits}`);
  if (digits.length === 11 && digits.startsWith('0')) return normalizePhone(`+${countryCallingCode}${digits.slice(1)}`);
  return normalizePhone(`+${digits}`);
}

export function mapLegacyLead(row, headers = LEGACY_LEAD_HEADERS) {
  const source = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']));
  const [firstName, ...lastNameParts] = String(source.Name ?? '').trim().split(/\s+/).filter(Boolean);
  const { sourceStatus, stageSlug } = normalizeLegacyStatus(source.Status);
  const phone = source.Phone ? String(source.Phone).trim() : null;
  const email = source['Investor Email'] ? String(source['Investor Email']).trim() : null;
  const dateValue = source['Date Added'] ? String(source['Date Added']).trim() : null;
  const budget = parseLegacyBudget(source.Budget);
  const normalizationWarnings = [];
  let phoneNormalized = null;
  let emailNormalized = null;
  if (phone) { try { phoneNormalized = normalizeLegacyPhone(phone); } catch { normalizationWarnings.push('PHONE_NOT_NORMALIZED'); } }
  if (email) { try { emailNormalized = normalizeEmail(email); } catch { normalizationWarnings.push('EMAIL_NOT_NORMALIZED'); } }
  const truthy = value => ['true', 'yes', '1', 'y'].includes(String(value ?? '').trim().toLowerCase());
  return {
    sourceId: String(source['Lead ID'] ?? '').trim(),
    firstName: firstName ?? null,
    lastName: lastNameParts.length ? lastNameParts.join(' ') : null,
    phone,
    phoneNormalized,
    email,
    emailNormalized,
    sourceName: String(source['Lead Source'] ?? '').trim() || null,
    budget,
    location: null,
    requirement: String(source['Next Action'] ?? '').trim() || null,
    status: String(source.Status ?? '').trim() || 'New Lead',
    stageSlug,
    score: Math.max(0, Number.parseInt(source.Score, 10) || 0),
    temperature: ['hot', 'warm', 'cold'].includes(String(source.Temperature ?? '').trim().toLowerCase())
      ? String(source.Temperature).trim().toLowerCase() : null,
    notes: String(source.Notes ?? '').trim() || null,
    doNotContact: truthy(source.DND),
    normalizationWarnings,
    migrationPayload: Object.fromEntries(Object.entries(source).map(([key, value]) => [key, value ?? ''])) ,
    addedAt: dateValue ? parseLegacyDate(dateValue) : null,
    nextActionAt: source['Next Follow-up'] ? parseLegacyDate(source['Next Follow-up']) : null,
    meetingAt: source['Meeting Date'] ? parseLegacyDate(source['Meeting Date']) : null
  };
}

