// Runs every movie and music popup browser test one after another and exits non-zero if any fails.
// One command so a task check does not need a shell that chains commands.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const tests = ['movies_web', 'movies_player', 'movies_visual', 'movies_episodes', 'movies_audio_tracks', 'movies_downloads',
  'movies_releases', 'movies_subtitles', 'movies_sound', 'movies_autosubtitles', 'movies_data_saver', 'movies_tracks',
  'movies_typing', 'movies_genre_shelves', 'movies_youtube', 'music_popup_unification'];
const failed = [];
for (const name of tests) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(__dirname, name + '.cjs')], { encoding: 'utf8', timeout: 600000 });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (run.status === 0) { console.log(`PASS ${name} (${seconds}s)`); continue; }
  failed.push(name);
  if (run.error) console.error(run.error.message);
  const text = `${run.stderr || ''}\n${run.stdout || ''}`.split('\n').filter(line => /Error|assert|expected|actual|at (verify|audit|async)|Timeout|waiting for/i.test(line)).slice(0, 8).join('\n');
  console.log(`FAIL ${name} (${seconds}s)\n${text}`);
}
console.log(failed.length ? `${failed.length} of ${tests.length} failed: ${failed.join(', ')}` : `All ${tests.length} passed`);
process.exit(failed.length ? 1 : 0);
