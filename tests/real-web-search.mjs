#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { loadEnv, getCsvEnv } from './env.js';

loadEnv();

function usage() {
  console.log(`Usage:
  node tests/real-web-search.mjs [--help]

This script reads its configuration from .env / process.env.

Required env:
  PI_WEB_SEARCH_MODEL_XAI
  PI_WEB_SEARCH_MODEL_OPENAI
  PI_WEB_SEARCH_MODEL_ANTHROPIC
  PI_WEB_SEARCH_MODEL_GOOGLE

Optional env:
  PI_BIN=pi
  PI_WEB_SEARCH_EXTENSION=./src/index.ts
  PI_PROVIDER_EXTENSIONS=/path/a.ts,/path/b.ts
  PI_WEB_SEARCH_PROMPT=...`);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  usage();
  process.exit(0);
}

const piBin = process.env.PI_BIN || 'pi';
const prompt = process.env.PI_WEB_SEARCH_PROMPT || '必须调用 web_search 搜索：OpenAI Responses API web search tool citations。回答里列出主要 URL。';
const pluginExtension = process.env.PI_WEB_SEARCH_EXTENSION || './src/index.ts';
const providerExtensions = getCsvEnv('PI_PROVIDER_EXTENSIONS');
const extensions = [...providerExtensions, pluginExtension];
const models = [
  process.env.PI_WEB_SEARCH_MODEL_XAI,
  process.env.PI_WEB_SEARCH_MODEL_OPENAI,
  process.env.PI_WEB_SEARCH_MODEL_ANTHROPIC,
  process.env.PI_WEB_SEARCH_MODEL_GOOGLE,
].filter(Boolean);

if (models.length === 0) {
  usage();
  throw new Error('No real web_search models configured. Set PI_WEB_SEARCH_MODEL_XAI / OPENAI / ANTHROPIC / GOOGLE in .env');
}

let failed = false;

for (const model of models) {
  const args = [
    '--no-session', '-ne', '-ns', '-np', '-nc', '--mode', 'json',
    ...extensions.flatMap((ext) => ['-e', ext]),
    '--model', model,
    '--tools', 'web_search',
    prompt,
  ];

  const run = spawnSync(piBin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const toolStarts = [];
  const toolEnds = [];

  for (const line of output.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'tool_execution_start' && event.toolName === 'web_search') toolStarts.push(event);
      if (event.type === 'tool_execution_end' && event.toolName === 'web_search') toolEnds.push(event);
    } catch {}
  }

  const latest = toolEnds.at(-1);
  const details = latest?.result?.details || {};
  const urls = [
    ...(details.sources || []).map((item) => item.url),
    ...(details.searchResults || []).map((item) => item.url),
    ...(details.citations || []).map((item) => item.url),
  ].filter(Boolean);
  const uniqueUrls = [...new Set(urls)];
  const ok = toolStarts.length > 0 && toolEnds.length > 0 && details.nativeSearchUsed === true && uniqueUrls.length > 0;

  console.log(`\n=== ${model} ===`);
  console.log(JSON.stringify({
    exitCode: run.status,
    toolStarted: toolStarts.length > 0,
    toolEnded: toolEnds.length > 0,
    providerKind: details.providerKind,
    nativeSearchUsed: details.nativeSearchUsed,
    nativeSearchEvents: details.nativeSearchEvents,
    searchQueries: details.searchQueries,
    resultCount: details.resultCount,
    grounded: details.grounded,
    urls: uniqueUrls,
  }, null, 2));

  if (!ok) {
    failed = true;
    console.error(`FAIL: ${model} did not return verifiable native web_search details with URLs.`);
  }
}

assert.equal(failed, false, 'One or more real web_search checks failed');
