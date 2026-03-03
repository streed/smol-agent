import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, fileExists, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "dependency-analysis", timeout: config.timeouts.medium };

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
  const events = collectEvents(agent);
  await seedFile(tmpDir, "app.js", SEED_APP);
  await seedFile(tmpDir, "package.json", JSON.stringify(SEED_PACKAGE, null, 2));

  try {
    const response = await runWithTimeout(
      agent,
      "Check which dependencies in package.json are not actually used in the code and list them",
      meta.timeout,
    );

    const didRead = events.anyToolCalled(["read_file"]);
    const didGrep = events.anyToolCalled(["grep"]);

    // The agent should mention that moment is unused
    const normalizedResponse = response.toLowerCase();
    const mentionsMoment = /moment/.test(normalizedResponse);
    const identifiesUnused = /unused|not.*use|remove/.test(normalizedResponse);

    // Should not falsely flag express, lodash, or axios
    const correctAboutExpress = !/express.*unused|remove.*express/i.test(response) ||
                               /express/.test(normalizedResponse);
    const correctAboutLodash = !/lodash.*unused|remove.*lodash/i.test(response) ||
                              /lodash/.test(normalizedResponse);

    // Should have analyzed the files
    const didAnalyze = didRead || didGrep;

    return scoreResult(meta.name, [
      check("analyzed files", didAnalyze, 2),
      check("read package.json", didRead, 1),
      check("mentions moment", mentionsMoment, 3, response.slice(0, 200)),
      check("identifies as unused", identifiesUnused, 3),
      check("correct about express", correctAboutExpress, 1),
      check("correct about lodash", correctAboutLodash, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
