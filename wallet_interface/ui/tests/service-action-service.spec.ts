import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";

import * as calendar from "../src/lib/calendar/ics";
import * as serviceActions from "../src/services/serviceActionService";

const requireRoot = createRequire(import.meta.url);
const serviceActionServiceTests = requireRoot("../../../tests/test_service_action_service.ts") as {
  registerServiceActionServiceTests: (testApi: typeof test, expectApi: typeof expect, actions: unknown, calendarApi: unknown) => void;
};

serviceActionServiceTests.registerServiceActionServiceTests(test, expect, serviceActions, calendar);
