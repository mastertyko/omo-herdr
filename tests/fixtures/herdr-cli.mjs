#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.OMO_HERDR_TEST_LOG, JSON.stringify(args) + "\n");
if (args[0] === "--version") console.log("herdr 0.9.0");
if (args[0] === "pane" && args[1] === "get") {
  if (process.env.OMO_HERDR_TEST_PROBE_FAIL === "1") {
    console.error("SECRET: raw errors must not be echoed by doctor");
    process.exit(1);
  }
  console.log(JSON.stringify({result:{pane:{pane_id:args[2],agent:"omo",agent_status:"idle"}}}));
}
