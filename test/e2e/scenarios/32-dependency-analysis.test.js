import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "dependency-analysis", timeout: config.timeouts.medium, category: "search", evalType: "capability", difficulty: "medium" };

const SEED_APP = `const express = require("express");
const _ = require("lodash");
const axios = require("axios");

const app = express();

app.get("/", (req, res) => {
  const data = _.chunk([1, 2, 3, 4], 2);
  res.json(data);
});

app.listen(3000);
`;

const SEED_PACKAGE = {
  "name": "test-app",
  "version": "1.0.0",
  "dependencies": {
    "express": "^4.18.0",
    "lodash": "^4.17.21",
    "axios": "^1.6.0",
    "moment": "^2.29.4"
  }
};

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  collectEvents(agent);
  await seedFile(tmpDir, "app.js", SEED_APP);
  await seedFile(tmpDir, "package.json", JSON.stringify(SEED_PACKAGE, null, 2));

  try {
    const response = await runWithTimeout(
      agent,
      "Check which dependencies in package.json are not actually used in the code and list them",
      meta.timeout,
    );

    // The agent should mention that moment is unused
    const normalizedResponse = response.toLowerCase();
    const mentionsMoment = /moment/.test(normalizedResponse);
    const identifiesUnused = /unused|not.*use|remove|unnecessary/i.test(normalizedResponse);

    // Should not falsely flag express, lodash, or axios as unused
    const doesNotFlagExpress = !/express.*unused|remove.*express|express.*not.*used/i.test(response);
    const doesNotFlagLodash = !/lodash.*unused|remove.*lodash|lodash.*not.*used/i.test(response);

    // Response coherence — should be a meaningful analysis
    const coherentResponse = response.length > 50;

    return scoreResult(meta.name, [
      check("mentions moment", mentionsMoment, 3, response.slice(0, 200)),
      check("identifies moment as unused", identifiesUnused, 3),
      check("does not falsely flag express", doesNotFlagExpress, 1),
      check("does not falsely flag lodash", doesNotFlagLodash, 1),
      check("coherent analysis response", coherentResponse, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
