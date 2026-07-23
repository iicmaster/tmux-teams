#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { analyzeExperiment, ContractValidationError } from './delivery-loop-core.mjs';

const diagnostic = (error, message, diagnostics = []) => JSON.stringify({ error, message, diagnostics });
async function main(args) {
  if (args.length !== 2 || args[0] !== 'analyze') {
    process.stderr.write(`${diagnostic('USAGE', 'Usage: node delivery-loop-poc.mjs analyze <json-file>')}\n`); process.exitCode = 2; return;
  }
  let input;
  try { input = JSON.parse(await readFile(args[1], 'utf8')); }
  catch (cause) { process.stderr.write(`${diagnostic('INPUT_READ_FAILED', 'Could not read a valid JSON input file.', [{ code: cause?.code ?? 'JSON_PARSE_FAILED', path: args[1], message: cause?.message ?? 'Input failure.' }])}\n`); process.exitCode = 1; return; }
  try { process.stdout.write(`${JSON.stringify(analyzeExperiment(input))}\n`); }
  catch (cause) { process.stderr.write(`${diagnostic(cause instanceof ContractValidationError ? cause.code : 'ANALYSIS_FAILED', cause instanceof ContractValidationError ? cause.message : 'Analyzer failed without producing a report.', cause instanceof ContractValidationError ? cause.errors : [])}\n`); process.exitCode = 1; }
}
await main(process.argv.slice(2));
