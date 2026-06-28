import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";

import * as offlineQueue from "../src/pwa/offlineInteractionQueue";

const requireRoot = createRequire(import.meta.url);
const offlineInteractionQueueTests = requireRoot("../../../tests/test_offline_interaction_queue.ts") as {
  registerOfflineInteractionQueueTests: (
    testApi: typeof test,
    expectApi: typeof expect,
    offlineQueueApi: unknown
  ) => void;
};

offlineInteractionQueueTests.registerOfflineInteractionQueueTests(test, expect, offlineQueue);
