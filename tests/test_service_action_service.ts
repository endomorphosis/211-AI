function registerServiceActionServiceTests(test: any, expect: any, serviceActions: any, calendar: any) {
  const {
    buildCalendarAction,
    buildCallAction,
    buildEmailAction,
    buildMapAction,
    buildMapLinks,
    buildShareAction,
    buildTextAction,
  } = serviceActions;
  const { buildIcsEvent } = calendar;

  test.describe("service action service", () => {
    test("builds call and text links only with dialable phone data", () => {
      expect(buildCallAction({ phone: " (503) 555-0100 ext. 42 " }).href).toBe("tel:5035550100;ext=42");
      expect(buildCallAction({ phone: "x" }).href).toBeUndefined();
      expect(buildCallAction({ phone: "x" }).observedStatus).toBe("unavailable");

      const textAction = buildTextAction({
        phone: "+1 (503) 555-0100",
        body: "Hello & thanks",
      });
      expect(textAction.href).toBe("sms:+15035550100?body=Hello%20%26%20thanks");
      expect(buildTextAction({ body: "hello" }).href).toBeUndefined();
    });

    test("builds mailto links with percent-encoded headers only with email data", () => {
      const emailAction = buildEmailAction({
        email: "help@example.org",
        subject: "Question about intake",
        body: "Line 1\nLine 2",
      });

      expect(emailAction.href).toBe("mailto:help@example.org?subject=Question%20about%20intake&body=Line%201%0ALine%202");
      expect(buildEmailAction({ email: "not an email" }).href).toBeUndefined();
    });

    test("builds map links from address or source URL without inventing a location query", () => {
      const links = buildMapLinks({ address: "123 Main St, Portland, OR" });
      expect(links.map((link) => [link.provider, link.href])).toEqual([
        ["google", "https://www.google.com/maps/search/?api=1&query=123%20Main%20St%2C%20Portland%2C%20OR"],
        ["apple", "https://maps.apple.com/?q=123%20Main%20St%2C%20Portland%2C%20OR"],
        ["geo", "geo:0,0?q=123%20Main%20St%2C%20Portland%2C%20OR"],
      ]);

      expect(
        buildMapAction({
          context: { providerName: "Provider name only", programName: "Program name only" },
        }).href,
      ).toBeUndefined();

      expect(
        buildMapAction({
          context: { sourceUrl: "https://211.example.test/services/svc-1" },
        }).href,
      ).toBe("https://211.example.test/services/svc-1");
    });

    test("builds share payloads from public service backing data and rejects empty shares", () => {
      const shareAction = buildShareAction({
        title: "Food pantry",
        text: "Bring ID.",
        sourceContentCid: "bafy-source",
        context: { providerName: "Neighborhood Help" },
      });

      expect(shareAction.shareData).toMatchObject({
        title: "Food pantry",
        text: expect.stringContaining("Source CID: bafy-source"),
      });
      expect(shareAction.shareData?.text).toContain("Verify details before visiting");
      expect(shareAction.shareData?.url).toBeUndefined();

      const emptyShare = buildShareAction({});
      expect(emptyShare.shareData).toBeUndefined();
      expect(emptyShare.observedStatus).toBe("unavailable");
    });

    test("builds valid calendar files and omits unsafe calendar URLs", () => {
      const calendarAction = buildCalendarAction({
        title: "Call intake",
        notes: "Ask about documents.",
        startsAt: "2026-05-10T17:30:00-07:00",
        durationMinutes: 45,
        location: "123 Main St, Portland, OR",
        url: "https://example.org/intake?ref=211&day=1",
        context: { serviceDocId: "svc-1" },
      });

      expect(calendarAction.fileName).toBe("20260511-call-intake.ics");
      expect(calendarAction.mimeType).toBe("text/calendar;charset=utf-8");
      expect(calendarAction.ics).toContain("BEGIN:VCALENDAR\r\nVERSION:2.0");
      expect(calendarAction.ics).toContain("\r\nBEGIN:VEVENT\r\n");
      expect(calendarAction.ics).toContain("DTSTART:20260511T003000Z");
      expect(calendarAction.ics).toContain("DTEND:20260511T011500Z");
      expect(calendarAction.ics).toContain("URL:https://example.org/intake?ref=211&day=1");
      expect(calendarAction.ics?.endsWith("\r\n")).toBe(true);

      const unsafeUrlEvent = buildIcsEvent({
        title: "Intake, visit; follow-up",
        description: "Bring ID\nArrive early",
        startsAt: "2026-05-10T17:30:00Z",
        url: "javascript:alert(1)",
      });
      expect(unsafeUrlEvent).toContain("SUMMARY:Intake\\, visit\\; follow-up");
      expect(unsafeUrlEvent).toContain("DESCRIPTION:Bring ID\\nArrive early");
      expect(unsafeUrlEvent).not.toContain("URL:javascript:");

      const missingBackingData = buildCalendarAction({ title: "Reminder" });
      expect(missingBackingData.ics).toBeUndefined();
      expect(missingBackingData.observedStatus).toBe("unavailable");

      const invalidCalendarData = buildCalendarAction({ title: "Reminder", startsAt: "not-a-date" });
      expect(invalidCalendarData.ics).toBeUndefined();
      expect(invalidCalendarData.observedStatus).toBe("unavailable");
    });
  });
}

module.exports = { registerServiceActionServiceTests };
