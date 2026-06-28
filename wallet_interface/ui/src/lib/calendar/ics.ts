export interface IcsAlarmInput {
  description?: string;
  triggerMinutesBefore?: number;
}

export interface IcsEventInput {
  uid?: string;
  title: string;
  description?: string;
  location?: string;
  url?: string;
  startsAt: Date | string;
  endsAt?: Date | string;
  durationMinutes?: number;
  allDay?: boolean;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  alarms?: IcsAlarmInput[];
}

export interface IcsCalendarInput {
  prodId?: string;
  method?: "PUBLISH" | "REQUEST";
  events: IcsEventInput[];
}

const DEFAULT_PROD_ID = "-//Abby 211//Service Navigation//EN";
const ICS_MIME_TYPE = "text/calendar;charset=utf-8";

export function buildIcsCalendar(input: IcsCalendarInput): string {
  if (input.events.length === 0) {
    throw new Error("At least one calendar event is required.");
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${escapeIcsText(input.prodId ?? DEFAULT_PROD_ID)}`,
    "CALSCALE:GREGORIAN",
    `METHOD:${input.method ?? "PUBLISH"}`,
    ...input.events.flatMap((event) => buildIcsEventLines(event)),
    "END:VCALENDAR",
  ];

  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

export function buildIcsEvent(input: IcsEventInput): string {
  return buildIcsCalendar({ events: [input] });
}

export function createIcsBlob(input: IcsCalendarInput | IcsEventInput): Blob {
  const content = "events" in input ? buildIcsCalendar(input) : buildIcsEvent(input);
  return new Blob([content], { type: ICS_MIME_TYPE });
}

export function createIcsFileName(title: string, startsAt?: Date | string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const datePart = startsAt ? formatIcsDate(toValidDate(startsAt, "startsAt")).slice(0, 8) : undefined;
  return [datePart, slug || "calendar-event"].filter(Boolean).join("-") + ".ics";
}

export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function buildIcsEventLines(input: IcsEventInput): string[] {
  const startsAt = toValidDate(input.startsAt, "startsAt");
  const endsAt = resolveEndDate(input, startsAt);
  const createdAt = toValidDate(input.createdAt ?? new Date(), "createdAt");
  const updatedAt = toValidDate(input.updatedAt ?? createdAt, "updatedAt");
  const uid = input.uid ?? `${hashString([input.title, startsAt.toISOString(), input.location].join("|"))}@abby-211.local`;
  const url = normalizeIcsUrl(input.url);

  return [
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(uid)}`,
    `DTSTAMP:${formatIcsDate(updatedAt)}`,
    `CREATED:${formatIcsDate(createdAt)}`,
    `LAST-MODIFIED:${formatIcsDate(updatedAt)}`,
    input.allDay ? `DTSTART;VALUE=DATE:${formatIcsAllDayDate(startsAt)}` : `DTSTART:${formatIcsDate(startsAt)}`,
    input.allDay ? `DTEND;VALUE=DATE:${formatIcsAllDayDate(endsAt)}` : `DTEND:${formatIcsDate(endsAt)}`,
    `SUMMARY:${escapeIcsText(input.title)}`,
    input.description ? `DESCRIPTION:${escapeIcsText(input.description)}` : undefined,
    input.location ? `LOCATION:${escapeIcsText(input.location)}` : undefined,
    url ? `URL:${url}` : undefined,
    ...(input.alarms ?? []).flatMap(buildIcsAlarmLines),
    "END:VEVENT",
  ].filter(isPresent);
}

function buildIcsAlarmLines(input: IcsAlarmInput): string[] {
  const minutes = Math.max(0, Math.floor(input.triggerMinutesBefore ?? 60));
  return [
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeIcsText(input.description ?? "Reminder")}`,
    `TRIGGER:-PT${minutes}M`,
    "END:VALARM",
  ];
}

function resolveEndDate(input: IcsEventInput, startsAt: Date): Date {
  if (input.endsAt) {
    const endsAt = toValidDate(input.endsAt, "endsAt");
    if (endsAt <= startsAt) {
      throw new Error("endsAt must be after startsAt.");
    }
    return endsAt;
  }

  const minutes = input.durationMinutes ?? (input.allDay ? 24 * 60 : 30);
  if (minutes <= 0) {
    throw new Error("durationMinutes must be greater than zero.");
  }
  return new Date(startsAt.getTime() + minutes * 60 * 1000);
}

function toValidDate(value: Date | string, fieldName: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid date.`);
  }
  return date;
}

function formatIcsDate(date: Date): string {
  return [
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
    "T",
    date.getUTCHours().toString().padStart(2, "0"),
    date.getUTCMinutes().toString().padStart(2, "0"),
    date.getUTCSeconds().toString().padStart(2, "0"),
    "Z",
  ].join("");
}

function formatIcsAllDayDate(date: Date): string {
  return [
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
  ].join("");
}

function foldIcsLine(line: string): string {
  const firstLineLimit = 75;
  const continuationLimit = 74;
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= firstLineLimit) return line;

  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  let currentLimit = firstLineLimit;

  for (const character of line) {
    const characterBytes = encoder.encode(character).length;
    if (current && currentBytes + characterBytes > currentLimit) {
      chunks.push(current);
      current = character;
      currentBytes = characterBytes;
      currentLimit = continuationLimit;
    } else {
      current += character;
      currentBytes += characterBytes;
    }
  }

  if (current) chunks.push(current);
  return chunks.join("\r\n ");
}

function normalizeIcsUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return undefined;

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function isPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
