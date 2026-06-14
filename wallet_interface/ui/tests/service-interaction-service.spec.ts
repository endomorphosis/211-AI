import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";

import * as serviceActions from "../src/services/serviceActionService";
import * as serviceInteractions from "../src/services/serviceInteractionService";

const requireRoot = createRequire(import.meta.url);
const serviceInteractionServiceTests = requireRoot("../../../tests/test_service_interaction_service.ts") as {
  registerServiceInteractionServiceTests: (
    testApi: typeof test,
    expectApi: typeof expect,
    interactionService: unknown,
    actionService: unknown
  ) => void;
};

serviceInteractionServiceTests.registerServiceInteractionServiceTests(test, expect, serviceInteractions, serviceActions);
