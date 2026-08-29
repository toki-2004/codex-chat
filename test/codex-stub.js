'use strict';
/* ---------------------------------------------------------------------------
 * Codex CLI stub for offline e2e tests.
 * Emits the JSONL event shapes that codex-cli prints in --json mode:
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"item.started","item":{"type":"command_execution","command":"..."}}
 *   {"type":"item.completed","item":{"type":"command_execution",...,
 *          "aggregated_output":"...","exit_code":0}}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 * Behavior is driven by marker words inside the prompt:
 *   CCX_CMDTEST    -> also emits one command_execution pair (echo hi)
 *   CCX_FAILRESUME -> when resuming, exits 1 with no events (resume fallback)
 *   PING           -> replies "PONG"
 * Every invocation is appended (one line, JSON) to $CCX_STUB_LOG when set.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const crypto = require('crypto');

const LOG = process.env.CCX_STUB_LOG;
function log(line) {
  if (LOG) {
    try { fs.appendFileSync(LOG, line + '\n'); } catch (e) { /* ignore */ }
  }
}

const args = process.argv.slice(2);
log('CALL ' + JSON.stringify(args));

if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.0.0-test\n');
  process.exit(0);
}

if (args[0] === 'delete') {
  log('DELETED ' + String(args[1] || ''));
  process.exit(0);
}

if (args[0] !== 'exec') {
  process.stderr.write('stub: unsupported command ' + String(args[0]) + '\n');
  process.exit(2);
}

// Parse: exec [--json] [-p profile] [-C dir] [-m model] [-s sandbox] [resume <id>] [flags] <prompt>
let isResume = false;
let threadId = null;
let prompt = '';
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === 'resume') { isResume = true; threadId = args[i + 1]; i++; }
  else if (a === '-p' || a === '-C' || a === '-m' || a === '-s') { i++; }
  else if (a.startsWith('-')) { /* flag, no value */ }
  else { prompt = a; } // prompt is the final positional argument
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// Simulated resume failure: exit non-zero without any event
if (isResume && prompt.indexOf('CCX_FAILRESUME') >= 0) {
  process.stderr.write('stub: simulated resume failure\n');
  process.exit(1);
}

if (prompt.indexOf('CCX_CMDTEST') >= 0) {
  emit({ type: 'item.started', item: { type: 'command_execution', command: 'echo hi' } });
  emit({ type: 'item.completed', item: { type: 'command_execution', command: 'echo hi', aggregated_output: 'hi', exit_code: 0 } });
}

const reply = (() => {
  if (prompt.indexOf('CCX_FAILRESUME') >= 0) return 'RECOVERED';
  if (prompt.indexOf('PING') >= 0) return isResume ? 'RESUMED-PONG' : 'PONG';
  return 'STUB-REPLY ' + String(prompt).slice(-30);
})();

if (!isResume) {
  emit({ type: 'thread.started', thread_id: 'T' + crypto.randomBytes(4).toString('hex') });
}
emit({ type: 'item.completed', item: { type: 'agent_message', text: reply } });
process.exit(0);
