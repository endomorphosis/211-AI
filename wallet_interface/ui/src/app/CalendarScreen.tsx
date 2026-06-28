import { useMemo } from "react";
import { Bell, CalendarClock, Clock, Download, ExternalLink, MapPin } from "lucide-react";
import { Badge, Button, Section, StatusBanner } from "../components/ui";
import { t, tFormat, type SupportedLocale } from "../lib/localization";
import type { CheckInPolicyDraft, ServiceInteractionEvent, ServicePlan } from "../models/abby";
import { downloadCalendarAction } from "../services/serviceActionService";

type CalendarEventKind = "appointment" | "follow-up" | "check-in";

type CalendarEvent = {
  id: string;
  kind: CalendarEventKind;
  title: string;
  provider: string;
  startsAt: Date;
  detail: string;
  reminderAt?: Date;
  location?: string;
  serviceDocId?: string;
  planId?: string;
  status?: string;
  durationMinutes: number;
};

type CalendarStats = {
  appointments: number;
  followUps: number;
  checkIns: number;
};

export function CalendarScreen({
  interactions,
  onOpenPlan,
  onOpenService,
  policy,
  siteLocale,
  servicePlans
}: {
  interactions: ServiceInteractionEvent[];
  onOpenPlan: (docId: string) => void;
  onOpenService: (docId: string) => void;
  policy: CheckInPolicyDraft;
  siteLocale: SupportedLocale;
  servicePlans: ServicePlan[];
}) {
  const events = useMemo(
    () => buildCalendarEvents({ interactions, policy, servicePlans, siteLocale }),
    [
      interactions,
      policy.intervalDays,
      policy.lastCheckInAt,
      policy.reminderChannels,
      siteLocale,
      servicePlans
    ]
  );
  const now = new Date();
  const upcomingEvents = events.filter((event) => event.startsAt.getTime() >= now.getTime());
  const pastEvents = events.filter((event) => event.startsAt.getTime() < now.getTime()).slice(-5).reverse();
  const nextEvent = upcomingEvents[0];
  const stats = events.reduce<CalendarStats>(
    (current, event) => ({
      appointments: current.appointments + (event.kind === "appointment" ? 1 : 0),
      followUps: current.followUps + (event.kind === "follow-up" ? 1 : 0),
      checkIns: current.checkIns + (event.kind === "check-in" ? 1 : 0)
    }),
    { appointments: 0, followUps: 0, checkIns: 0 }
  );

  return (
    <div className="screen calendar-screen">
      <div className="page-title">
        <p className="eyebrow">{t(siteLocale, "calendar.eyebrow")}</p>
        <h1>{t(siteLocale, "calendar.title")}</h1>
      </div>
      <p className="page-note">{t(siteLocale, "calendar.note")}</p>

      <section className="calendar-summary-grid" aria-label={t(siteLocale, "calendar.summaryAria")}>
        <div className="calendar-summary-panel">
          <span>{t(siteLocale, "calendar.nextItem")}</span>
          <strong>{nextEvent ? formatRelativeDay(nextEvent.startsAt, now, siteLocale) : t(siteLocale, "calendar.noUpcomingItems")}</strong>
          <small>{nextEvent ? `${nextEvent.title} ${formatTime(nextEvent.startsAt, siteLocale)}` : t(siteLocale, "calendar.nextItemHint")}</small>
        </div>
        <div className="calendar-summary-panel">
          <span>{t(siteLocale, "calendar.appointments")}</span>
          <strong>{stats.appointments}</strong>
          <small>{t(siteLocale, "calendar.appointmentsHelp")}</small>
        </div>
        <div className="calendar-summary-panel">
          <span>{t(siteLocale, "calendar.followUps")}</span>
          <strong>{stats.followUps}</strong>
          <small>{t(siteLocale, "calendar.followUpsHelp")}</small>
        </div>
      </section>

      {nextEvent ? (
        <StatusBanner tone="info">
          {tFormat(siteLocale, "calendar.nextUp", {
            title: nextEvent.title,
            time: formatDateTime(nextEvent.startsAt, siteLocale),
            travel: nextEvent.location ? tFormat(siteLocale, "calendar.travelTarget", { location: nextEvent.location }) : ""
          })}
        </StatusBanner>
      ) : null}

      <Section title={t(siteLocale, "calendar.upcomingSchedule")}>
        {upcomingEvents.length > 0 ? (
          <div className="calendar-list">
            {upcomingEvents.map((event) => (
              <CalendarEventRow
                event={event}
                key={event.id}
                now={now}
                onOpenPlan={onOpenPlan}
                onOpenService={onOpenService}
                siteLocale={siteLocale}
              />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <h3>{t(siteLocale, "calendar.noUpcomingTitle")}</h3>
            <p>{t(siteLocale, "calendar.noUpcomingBody")}</p>
          </div>
        )}
      </Section>

      {pastEvents.length > 0 ? (
        <Section title={t(siteLocale, "calendar.pastItems")}>
          <div className="calendar-list">
            {pastEvents.map((event) => (
              <CalendarEventRow
                event={event}
                key={event.id}
                now={now}
                onOpenPlan={onOpenPlan}
                onOpenService={onOpenService}
                siteLocale={siteLocale}
              />
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

function CalendarEventRow({
  event,
  now,
  onOpenPlan,
  onOpenService,
  siteLocale
}: {
  event: CalendarEvent;
  now: Date;
  onOpenPlan: (docId: string) => void;
  onOpenService: (docId: string) => void;
  siteLocale: SupportedLocale;
}) {
  const isPast = event.startsAt.getTime() < now.getTime();

  function addToCalendar() {
    downloadCalendarAction({
      title: event.title,
      startsAt: event.startsAt,
      durationMinutes: event.durationMinutes,
      location: event.location,
      notes: buildCalendarNotes(event, siteLocale),
      alarms: event.reminderAt ? [buildAlarm(event)] : undefined,
      context: {
        providerName: event.provider,
        serviceDocId: event.serviceDocId,
        serviceTitle: event.title
      }
    });
  }

  return (
    <article className={`calendar-event-item ${isPast ? "calendar-event-past" : ""}`}>
      <div className="calendar-date-block" aria-label={formatDateTime(event.startsAt, siteLocale)}>
        <strong>{formatRelativeDay(event.startsAt, now, siteLocale)}</strong>
        <span>{formatTime(event.startsAt, siteLocale)}</span>
      </div>
      <div className="calendar-event-body">
        <div className="badge-row">
          <Badge tone={event.kind === "appointment" ? "success" : event.kind === "follow-up" ? "warning" : "info"}>
            {eventKindLabel(event.kind, siteLocale)}
          </Badge>
          {event.status ? <Badge>{event.status}</Badge> : null}
          {isPast ? <Badge>{t(siteLocale, "calendar.past")}</Badge> : null}
        </div>
        <h3>{event.title}</h3>
        <p>{event.detail}</p>
        <dl className="calendar-event-meta">
          <div>
            <Clock aria-hidden="true" size={16} />
            <dt>{t(siteLocale, "calendar.when")}</dt>
            <dd>{formatDateTime(event.startsAt, siteLocale)}</dd>
          </div>
          {event.location ? (
            <div>
              <MapPin aria-hidden="true" size={16} />
              <dt>{t(siteLocale, "calendar.travel")}</dt>
              <dd>{event.location}</dd>
            </div>
          ) : null}
          {event.reminderAt ? (
            <div>
              <Bell aria-hidden="true" size={16} />
              <dt>{t(siteLocale, "calendar.reminder")}</dt>
              <dd>{formatDateTime(event.reminderAt, siteLocale)}</dd>
            </div>
          ) : null}
          {event.provider ? (
            <div>
              <CalendarClock aria-hidden="true" size={16} />
              <dt>{t(siteLocale, "calendar.provider")}</dt>
              <dd>{event.provider}</dd>
            </div>
          ) : null}
        </dl>
      </div>
      <div className="row-actions calendar-event-actions">
        <Button onClick={addToCalendar} variant="secondary">
          <Download aria-hidden="true" size={18} />
          {t(siteLocale, "calendar.addToCalendar")}
        </Button>
        {event.planId && event.serviceDocId ? (
          <Button onClick={() => onOpenPlan(event.serviceDocId ?? "")} variant="secondary">
            <ExternalLink aria-hidden="true" size={18} />
            {t(siteLocale, "calendar.openPlan")}
          </Button>
        ) : event.serviceDocId ? (
          <Button onClick={() => onOpenService(event.serviceDocId ?? "")} variant="secondary">
            <ExternalLink aria-hidden="true" size={18} />
            {t(siteLocale, "calendar.openService")}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function buildCalendarEvents({
  interactions,
  policy,
  siteLocale,
  servicePlans
}: {
  interactions: ServiceInteractionEvent[];
  policy: CheckInPolicyDraft;
  siteLocale: SupportedLocale;
  servicePlans: ServicePlan[];
}): CalendarEvent[] {
  const planEvents = servicePlans.flatMap((plan): CalendarEvent[] => {
    const appointmentAt = parseDate(plan.appointment_at);
    if (!appointmentAt) return [];

    const title = firstPresent(plan.service_title, plan.provider_name, t(siteLocale, "calendar.defaultAppointmentTitle"));
    return [
      {
        id: `plan:${plan.plan_id}`,
        kind: "appointment",
        title,
        provider: plan.provider_name,
        startsAt: appointmentAt,
        detail: firstPresent(plan.goal, t(siteLocale, "calendar.defaultAppointmentDetail")),
        reminderAt: parseDate(plan.reminder_at) ?? undefined,
        location: trimToUndefined(plan.travel_target),
        serviceDocId: trimToUndefined(plan.service_doc_id),
        planId: plan.plan_id,
        status: trimToUndefined(plan.status),
        durationMinutes: 60
      }
    ];
  });

  const followUpEvents = interactions.flatMap((interaction): CalendarEvent[] => {
    const followUpAt = parseDate(interaction.next_follow_up_at);
    if (!followUpAt) return [];

    const title = firstPresent(interaction.next_action, interaction.program_name, interaction.provider_name, t(siteLocale, "calendar.defaultFollowUpTitle"));
    const provider = firstPresent(interaction.provider_name, interaction.counterparty_name);
    return [
      {
        id: `follow-up:${interaction.interaction_id}`,
        kind: "follow-up",
        title,
        provider,
        startsAt: followUpAt,
        detail: firstPresent(interaction.outcome, interaction.program_name, t(siteLocale, "calendar.defaultFollowUpDetail")),
        serviceDocId: trimToUndefined(interaction.service_doc_id),
        status: trimToUndefined(interaction.status),
        durationMinutes: 30
      }
    ];
  });

  const checkInEvent = buildCheckInEvent(policy, siteLocale);
  return [...planEvents, ...followUpEvents, ...(checkInEvent ? [checkInEvent] : [])].sort(
    (left, right) => left.startsAt.getTime() - right.startsAt.getTime()
  );
}

function buildCheckInEvent(policy: CheckInPolicyDraft, locale: SupportedLocale): CalendarEvent | null {
  const lastCheckInAt = parseDate(policy.lastCheckInAt);
  if (!lastCheckInAt || !Number.isFinite(policy.intervalDays) || policy.intervalDays <= 0) return null;

  const startsAt = new Date(lastCheckInAt);
  startsAt.setDate(startsAt.getDate() + policy.intervalDays);
  const channels = (policy.reminderChannels.length > 0 ? policy.reminderChannels : ["web"]).map((channel) => {
    if (channel === "sms") return t(locale, "channel.sms");
    if (channel === "email") return t(locale, "channel.email");
    return t(locale, "channel.web");
  }).join(", ");

  return {
    id: `check-in:${policy.lastCheckInAt}:${policy.intervalDays}`,
    kind: "check-in",
    title: t(locale, "calendar.checkInTitle"),
    provider: t(locale, "calendar.abby"),
    startsAt,
    detail: tFormat(locale, "calendar.reminderChannels", { channels }),
    durationMinutes: 15
  };
}

function buildAlarm(event: CalendarEvent) {
  if (!event.reminderAt) {
    return { description: event.title, triggerMinutesBefore: 60 };
  }

  const minutes = Math.max(0, Math.round((event.startsAt.getTime() - event.reminderAt.getTime()) / 60000));
  return { description: event.title, triggerMinutesBefore: minutes };
}

function buildCalendarNotes(event: CalendarEvent, locale: SupportedLocale): string {
  return [
    event.detail,
    event.provider ? tFormat(locale, "calendar.notes.provider", { value: event.provider }) : "",
    event.location ? tFormat(locale, "calendar.notes.travel", { value: event.location }) : "",
    event.reminderAt ? tFormat(locale, "calendar.notes.reminder", { value: formatDateTime(event.reminderAt, locale) }) : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function parseDate(value: string): Date | null {
  if (!value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function firstPresent(...values: string[]): string {
  return values.map((value) => value.trim()).find(Boolean) ?? "";
}

function trimToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function eventKindLabel(kind: CalendarEventKind, locale: SupportedLocale): string {
  if (kind === "appointment") return t(locale, "calendar.kind.appointment");
  if (kind === "follow-up") return t(locale, "calendar.kind.followUp");
  return t(locale, "calendar.kind.checkIn");
}

function formatRelativeDay(date: Date, now: Date, locale: SupportedLocale): string {
  const today = startOfDay(now);
  const target = startOfDay(date);
  const days = Math.round((target.getTime() - today.getTime()) / 86400000);

  if (days === 0) return t(locale, "calendar.today");
  if (days === 1) return t(locale, "calendar.tomorrow");
  if (days === -1) return t(locale, "calendar.yesterday");
  return formatDate(date, locale);
}

function formatDateTime(date: Date, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatDate(date: Date, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function formatTime(date: Date, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
