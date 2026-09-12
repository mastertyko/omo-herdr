#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.OMO_HERDR_TEST_LOG, JSON.stringify(process.argv.slice(2)) + "\n");
