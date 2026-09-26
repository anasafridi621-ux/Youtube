'use strict';
/**
 * tests/harness.js
 * ---------------------------------------------------------------------------
 * Minimal dependency-free test harness (the repo's existing test.js uses the
 * same style: no framework, plain assertions, non-zero exit on failure).
 */

const results = { passed: 0, failed: 0, skipped: 0, failures: [] };
const pending = [];           // every async test/suite promise
let currentSuite = '';
let tail = Promise.resolve(); // serialises async tests
const only = process.env.TEST_FILTER ? new RegExp(process.env.TEST_FILTER, 'i') : null;

/** Track an async test so `done()` can await it. */
function track(p) {
  if (p && typeof p.then === 'function') pending.push(p);
  return p || Promise.resolve();
}

/** Queue an async unit of work so it runs after the previous one. */
function serialise(fn) {
  const next = tail.then(fn, fn);
  tail = next.then(() => {}, () => {});
  return next;
}

function suite(name, fn) {
  currentSuite = name;
  // Always execute the suite body so individual tests can be filtered by name.
  console.log(`\n\x1b[1m${name}\x1b[0m`);
  try {
    return track(fn());
  } catch (err) {
    results.failed += 1;
    results.failures.push({ suite: name, name: '(suite setup)', error: err });
    console.log(`  \x1b[31m\u2717 suite threw: ${err.message}\x1b[0m`);
    return Promise.resolve();
  }
}

function test(name, fn) {
  const suiteName = currentSuite; // capture at registration, not at resolution
  if (only && !only.test(suiteName) && !only.test(name)) return;
  const done = (err) => {
    if (err) {
      results.failed += 1;
      results.failures.push({ suite: suiteName, name, error: err });
      console.log(`  \x1b[31m\u2717 ${name}\x1b[0m\n      ${err && err.message}`);
    } else {
      results.passed += 1;
      console.log(`  \x1b[32m\u2713\x1b[0m ${name}`);
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      // Serialise so async tests never share state or interleave output.
      return track(serialise(() => out.then(() => done(null), done)));
    }
    done(null);
  } catch (err) {
    done(err);
  }
  return Promise.resolve();
}

function skip(name) {
  results.skipped += 1;
  console.log(`  \x1b[33m○ ${name} (skipped)\x1b[0m`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'not deep equal'}:\n  expected ${b}\n  got      ${a}`);
}

function ok(v, msg) {
  assert(Boolean(v), msg || `expected truthy, got ${v}`);
}

function throws(fn, msg) {
  let threw = false;
  try {
    fn();
  } catch (_) {
    threw = true;
  }
  assert(threw, msg || 'expected function to throw');
}

async function rejects(promise, msg) {
  let threw = false;
  try {
    await promise;
  } catch (_) {
    threw = true;
  }
  assert(threw, msg || 'expected promise to reject');
}

/** Await every registered async test, then print the summary. */
async function done() {
  await Promise.all(pending.slice());
  console.log(`\n\x1b[1mSummary\x1b[0m: ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped`);
  if (results.failed) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    for (const f of results.failures) {
      console.log(`  [${f.suite}] ${f.name}: ${f.error && f.error.message}`);
    }
    process.exitCode = 1;
  }
  return results;
}

module.exports = { suite, test, skip, assert, eq, deepEq, ok, throws, rejects, done, results };
